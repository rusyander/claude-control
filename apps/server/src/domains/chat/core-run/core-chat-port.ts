import type { CommandOutcome } from '@agentdeck/contracts/core/commands';
import {
  taskAttachmentsPath,
  type EstimateReply,
  type TaskAttachmentReply,
} from '@agentdeck/contracts/core/estimate';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { TaskReply } from '@agentdeck/contracts/core/panel-api';
import {
  SESSION_STREAM_SSE_EVENT,
  type SessionStreamPage,
} from '@agentdeck/contracts/core/session-stream';
import type { CoreCaller } from '../../core-ask/core-ask.ts';
import { parseSse } from '../../core-relay/sse.ts';
import type { CoreChatPort } from './core-run.types.ts';

/**
 * Ручки ядра для хода чата (этап 10, F2, проход 3) поверх `CoreCaller`: тот же звонок, что у
 * вопроса агента панели, — запись ядра со сверкой слушателя, bearer панели, число загрузки на
 * каждую команду класса `human`. Отказ ядра отдаётся с его кодом и словами дословно.
 */

type ErrorBody = {
  code?: string;
  error?: string;
  problems?: string[];
  issues?: Array<{ path?: string; message?: string }>;
};

const bodyOf = async <T>(res: Response): Promise<T & ErrorBody> =>
  (await res.json().catch(() => ({}))) as T & ErrorBody;

const reasonOf = (body: ErrorBody): string =>
  [
    body.error,
    ...(body.problems ?? []),
    ...(body.issues ?? []).map((i) => [i.path, i.message].filter(Boolean).join(': ')),
  ]
    .filter(Boolean)
    .join(': ');

const sessionPath = (taskId: string, sessionId: string): string =>
  `/v1/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}/stream`;

export function createCoreChatPort(caller: CoreCaller): CoreChatPort {
  const { call, proof, cmdId } = caller;
  return {
    async estimate(fields, env, attachments) {
      const res = await call({
        method: 'POST',
        path: '/v1/estimate',
        body: {
          cmdId: cmdId(),
          fields,
          proof: await proof(),
          ...(env ? { env } : {}),
          ...(attachments?.length ? { attachments } : {}),
        },
      });
      const body = await bodyOf<Partial<EstimateReply>>(res);
      if (!res.ok || !body.taskId) {
        // Отказ оценки (422) — причины ядра без его русской шапки «Задача не создана»: они едут в
        // текст чата на языке интерфейса (`refusal-text.ts`), шапку переводит сам шаблон.
        const problems = body.code === 'estimate-refused' ? (body.problems ?? []) : [];
        const message = problems.length > 0 ? problems.join('; ') : reasonOf(body);
        return { ok: false, code: body.code ?? `http-${res.status}`, message };
      }
      if (body.state === 'refused') {
        // Задача есть, но не пойдёт: дорога предпроверки упала или поля негодны.
        const failed = (body.preflight ?? [])
          .filter((p) => p.status === 'failed')
          .map((p) => `${p.road}: ${p.detail}`);
        return {
          ok: false,
          code: 'estimate-refused',
          taskId: body.taskId,
          message: [...failed, ...(body.problems ?? [])].join('; ') || 'refused',
        };
      }
      return { ok: true, taskId: body.taskId };
    },
    async command(taskId, kind, fields) {
      const res = await call({
        method: 'POST',
        path: '/v1/commands',
        body: { cmdId: cmdId(), kind, target: { taskId }, fields, proof: await proof() },
      });
      const body = await bodyOf<Partial<CommandOutcome>>(res);
      if (body.status === 'applied' || body.status === 'rejected') return body as CommandOutcome;
      // Конверт не дошёл до суда команд (400 схемы, 403 доказательства): исход тем же видом.
      return {
        cmdId: '',
        status: 'rejected',
        code: body.code ?? `http-${res.status}`,
        reason: reasonOf(body),
        seq: 0,
      };
    },
    async attach(taskId, attachment) {
      const res = await call({
        method: 'POST',
        path: taskAttachmentsPath(taskId),
        body: { cmdId: cmdId(), attachment, proof: await proof() },
      });
      const body = await bodyOf<Partial<TaskAttachmentReply>>(res);
      if (!res.ok || typeof body.file !== 'string') {
        return { ok: false, code: body.code ?? `http-${res.status}`, message: reasonOf(body) };
      }
      return { ok: true, file: body.file };
    },
    async view(taskId) {
      const res = await call({ method: 'GET', path: `/v1/tasks/${encodeURIComponent(taskId)}` });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`core task ${taskId}: HTTP ${res.status}`);
      return ((await res.json()) as TaskReply).view;
    },
    async page(taskId, sessionId, from) {
      const res = await call({
        method: 'GET',
        path: `${sessionPath(taskId, sessionId)}?from=${from}`,
      });
      if (!res.ok) throw new Error(`core session page: HTTP ${res.status}`);
      return (await res.json()) as SessionStreamPage;
    },
    async *follow(taskId, sessionId, from, signal) {
      const res = await call({
        method: 'GET',
        path: `${sessionPath(taskId, sessionId)}?follow=1&from=${from}`,
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`core session stream: HTTP ${res.status}`);
      for await (const frame of parseSse(res.body)) {
        if (frame.event !== SESSION_STREAM_SSE_EVENT) continue;
        yield JSON.parse(frame.data) as SessionStreamPage;
      }
    },
    async *taskEvents(taskId, signal) {
      const res = await call({
        method: 'GET',
        path: `/v1/tasks/${encodeURIComponent(taskId)}/events`,
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`core task events: HTTP ${res.status}`);
      for await (const frame of parseSse(res.body)) {
        yield JSON.parse(frame.data) as JournalLine;
      }
    },
  };
}

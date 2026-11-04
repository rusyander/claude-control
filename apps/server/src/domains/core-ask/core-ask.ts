import { randomUUID } from 'node:crypto';
import type { AskFields, AskReply } from '@agentdeck/contracts/core/ask';
import type { TaskReply } from '@agentdeck/contracts/core/panel-api';
import {
  SESSION_STREAM_SSE_EVENT,
  sessionEventKeys,
  type SessionStreamEvent,
  type SessionStreamPage,
} from '@agentdeck/contracts/core/session-stream';
import {
  createCoreIdentityDeps,
  type CoreIdentityDeps,
} from '../../lib/listen-identity/listen-identity.ts';
import {
  forwardToCore,
  locateCore,
  verifyCore,
  type CoreForward,
  type CoreLocation,
} from '../core-proxy/core-proxy.ts';
import { parseSse } from '../core-relay/sse.ts';
import { serverText } from '../../lib/server-texts/server-texts.ts';
import type { CoreAskEvent, CoreAskOutcome, CoreAskPort, CoreAskRun } from './core-ask.types.ts';

/**
 * Вопрос модели через ядро (этап 10, F2, проход 2c): у панели больше нет своего процесса CLI —
 * ход агента панели, вопрос группы и ассистент просят ядро (`POST /v1/ask`), ядро запускает
 * сессию своей дорогой (маршрут, контур, DLP, журнал), панель читает вид сеанса потоком.
 *
 * Доказательство человека — число загрузки страницы, которое панель берёт у ядра своим токеном
 * (`/v1/nonce`): панель — не потомок сессии, суд ядра (`ask` — класс `human`) это видит по пиру.
 * Модель такого числа не получит: её токен — токен сессии, и ядро отказывает ему с записью.
 */

/** Шаг опроса вида задачи, пока сессия не названа (`session.started`). */
const SESSION_POLL_MS = 150;
/** Сколько ждать первой сессии: ядро открывает её в цикле исполнителя (доли секунды). */
const SESSION_WAIT_MS = 60_000;

/**
 * Звонок ядру от имени панели: адрес из записи ядра (с проверкой личности слушателя) и число
 * загрузки для команд класса `human`. Один на вопрос агента и на ход чата (`chat/core-run`):
 * обе дороги — панель как человек, и проверять запись ядра им одинаково.
 */
export interface CoreCaller {
  call(forward: CoreForward): Promise<Response>;
  proof(): Promise<{ nonce: string; page: string }>;
  cmdId(): string;
}

export function createCoreCaller(
  home: () => string,
  identity: (port: number) => CoreIdentityDeps = createCoreIdentityDeps(),
): CoreCaller {
  const located = async (): Promise<CoreLocation> => {
    const core = locateCore(home());
    if ('missing' in core) throw new Error(`core is not running: ${core.missing}`);
    const proven = await verifyCore(core, identity(core.entry.port));
    if (!('value' in proven)) {
      throw new Error(
        `core entry not verified: ${'unknown' in proven ? proven.unknown : 'absent'}`,
      );
    }
    return core;
  };
  const call = async (forward: CoreForward): Promise<Response> =>
    forwardToCore(await located(), forward);
  return {
    call,
    async proof() {
      // Ядро принимает номер загрузки только UUIDv7 (`/v1/nonce` — 400 на иной).
      const page = randomUUID7();
      const res = await call({ method: 'GET', path: `/v1/nonce?page=${page}` });
      if (!res.ok) throw new Error(`core nonce: HTTP ${res.status}`);
      return { nonce: ((await res.json()) as { nonce: string }).nonce, page };
    },
    cmdId: randomUUID7,
  };
}

export function createCoreAskPort(
  home: () => string,
  identity: (port: number) => CoreIdentityDeps = createCoreIdentityDeps(),
): CoreAskPort {
  const { call, proof } = createCoreCaller(home, identity);
  return createAskPortOver(call, proof);
}

function createAskPortOver(call: CoreCaller['call'], proof: CoreCaller['proof']): CoreAskPort {
  return {
    async ask(fields, env) {
      const res = await call({
        method: 'POST',
        path: '/v1/ask',
        body: {
          cmdId: randomUUID7(),
          fields,
          proof: await proof(),
          ...(env && Object.keys(env).length > 0 ? { env } : {}),
        },
      });
      // Отказ ядра — `apiError`: `{error, code, problems?|issues?}`.
      const body = (await res.json().catch(() => ({}))) as Partial<AskReply> & {
        code?: string;
        error?: string;
        problems?: string[];
        issues?: Array<{ path?: string; message?: string }>;
      };
      if (res.ok && body.taskId) return { ok: true, taskId: body.taskId };
      return {
        ok: false,
        status: res.status,
        code: body.code ?? `http-${res.status}`,
        message: [
          body.error,
          ...(body.problems ?? []),
          ...(body.issues ?? []).map((i) => [i.path, i.message].filter(Boolean).join(': ')),
        ]
          .filter(Boolean)
          .join(': '),
      };
    },
    async task(taskId) {
      const res = await call({ method: 'GET', path: `/v1/tasks/${encodeURIComponent(taskId)}` });
      if (!res.ok) throw new Error(`core task ${taskId}: HTTP ${res.status}`);
      return ((await res.json()) as TaskReply).view;
    },
    async *pages(taskId, sessionId, signal) {
      const res = await call({
        method: 'GET',
        path: `/v1/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}/stream?follow=1`,
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`core session stream: HTTP ${res.status}`);
      for await (const frame of parseSse(res.body)) {
        if (frame.event !== SESSION_STREAM_SSE_EVENT) continue;
        yield JSON.parse(frame.data) as SessionStreamPage;
      }
    },
    async cancel(taskId) {
      // Ядро ушло — снимать нечего; отказ числа загрузки тоже не должен всплыть необработанным.
      await proof()
        .then((p) =>
          call({
            method: 'POST',
            path: '/v1/commands',
            body: {
              cmdId: randomUUID7(),
              kind: 'cancel',
              target: { taskId },
              // `reason` обязателен схемой ядра: без него команда — 400, и «Стоп» молча не снимал задачу.
              fields: { reason: 'stopped by the human in the panel' },
              proof: p,
            },
          }),
        )
        .catch(() => undefined);
    },
  };
}

/** uuidv7 для `cmdId`: ядро принимает только его (сортируемый ключ повтора). */
export function randomUUID7(): string {
  const ms = BigInt(Date.now()).toString(16).padStart(12, '0');
  const rnd = randomUUID().replace(/-/g, '');
  const variant = ((parseInt(rnd[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${ms.slice(0, 8)}-${ms.slice(8)}-7${rnd.slice(13, 16)}-${variant}${rnd.slice(17, 20)}-${rnd.slice(20, 32)}`;
}

/** Имя инструмента модели → имя действия панели: `mcp__panel-bridge__<имя>`. */
const BRIDGE_TOOL = /^mcp__panel-bridge__(.+)$/;

/**
 * Один ход вопроса: просьба ядру, ожидание сессии, вид сеанса до конца хода. События — в
 * словаре окна агента (`text`, `tool`, `tool-result`, `done`, `error`); конец хода — итог с
 * ответом и списком действий. `stop` — команда ядру `cancel` и обрыв чтения.
 */
export function runCoreAsk(
  port: CoreAskPort,
  fields: AskFields,
  onEvent: (event: CoreAskEvent) => void,
  opts: {
    pollMs?: number;
    waitMs?: number;
    onTask?: (taskId: string) => void;
    /** Отрезок текста перед вызовом действия — рабочая заметка, а не слово человеку. */
    holdNote?: (segment: string) => boolean;
    /** Значения имён `fields.session.env` (набор помощника чужому CLI, G13). */
    env?: Readonly<Record<string, string>>;
  } = {},
): CoreAskRun {
  const abort = new AbortController();
  let taskId: string | undefined;
  let stopped = false;
  // Команда ядру `cancel` — одна на ход; конец хода ждёт её, чтобы ход не считался кончившимся,
  // пока ядру ещё не сказано снять сессию.
  let cancelling: Promise<void> | undefined;
  const cancel = (): void => {
    if (taskId) cancelling ??= port.cancel(taskId);
  };
  const run = async (): Promise<CoreAskOutcome> => {
    const actions: string[] = [];
    // Ошибку человеку называет вызывающий: у «Стоп», потолка и отказа ядра свои тексты и коды.
    const fail = (message: string, code?: string): CoreAskOutcome => ({
      ok: false,
      reply: '',
      error: message,
      ...(code ? { code } : {}),
      actions,
    });
    const asked = await port.ask(fields, opts.env).catch((error: unknown) => ({
      ok: false as const,
      status: 0,
      code: 'core-unreachable',
      message: String(error instanceof Error ? error.message : error),
    }));
    if (!asked.ok) return fail(asked.message || asked.code, asked.code);
    taskId = asked.taskId;
    opts.onTask?.(taskId);
    if (stopped) cancel();
    const waited = await waitSession(port, taskId, abort.signal, opts);
    if (!('sessionId' in waited)) {
      return stopped
        ? fail('stopped', 'stopped')
        : fail(waited.reason ?? 'core opened no session for the ask', 'no-session');
    }
    const { sessionId } = waited;
    const names = new Map<string, string>();
    const seen = new Set<string>();
    const shown: string[] = [];
    // Текст между вызовами копится отрезком: заметку перед действием (`holdNote`) видно только
    // целиком, а куски потока режут её где попало. Последний отрезок — ответ, он идёт всегда.
    // Блоки отрезка уходят в ленту каждый своим кадром, ответ — блоки через пустую строку.
    let segment: string[] = [];
    const flush = (beforeTool: boolean): void => {
      if (segment.length > 0 && !(beforeTool && opts.holdNote?.(segment.join('')))) {
        for (const text of segment) {
          shown.push(text);
          onEvent({ kind: 'text', text });
        }
      }
      segment = [];
    };
    // Итог, найденный в потоке, держится вне цикла: закрытие чтения (обрыв SSE) может бросить
    // и подменить собой `return` изнутри `for await`.
    let outcome: CoreAskOutcome | undefined;
    try {
      read: for await (const page of port.pages(taskId, sessionId, abort.signal)) {
        const keys = sessionEventKeys(page.events);
        for (const [i, event] of page.events.entries()) {
          if (seen.has(keys[i]!)) continue;
          seen.add(keys[i]!);
          const out = eventOf(event, names);
          if (!out) continue;
          switch (out.kind) {
            case 'text':
              segment.push(out.text);
              continue;
            case 'foreign-tool':
              // Встроенных инструментов у вопроса нет по запуску ядра; вызов чего-то кроме моста —
              // ход с руками, которых агенту не положено: обрыв, а не тихий пропуск.
              outcome = fail(out.name, 'extra-tool');
              stopped = true;
              cancel();
              break read;
            case 'tool':
              flush(true);
              break;
            case 'tool-result':
              actions.push(out.isError ? `${out.name} (failed)` : out.name);
              break;
            case 'error':
              outcome = fail(out.message, 'session-error');
              break read;
            case 'done':
              flush(false);
              {
                const reply = shown.join('\n\n').trim();
                onEvent({ kind: 'done', reply });
                outcome = { ok: true, reply, actions };
              }
              break read;
          }
          onEvent(out);
        }
        if (page.done) break;
      }
    } catch (error) {
      if (!outcome && !stopped) {
        return fail(`core session stream broke: ${String(error)}`, 'stream-broke');
      }
    } finally {
      abort.abort();
    }
    if (outcome) return outcome;
    return stopped
      ? fail('stopped', 'stopped')
      : fail('the session ended without an answer', 'no-answer');
  };
  const done = run().then(async (outcome) => {
    await cancelling;
    return outcome;
  });
  return {
    done,
    taskId: () => taskId,
    stop: () => {
      stopped = true;
      cancel();
      abort.abort();
    },
  };
}

async function waitSession(
  port: CoreAskPort,
  taskId: string,
  signal: AbortSignal,
  opts: { pollMs?: number; waitMs?: number },
): Promise<{ sessionId: string } | { reason?: string }> {
  const deadline = Date.now() + (opts.waitMs ?? SESSION_WAIT_MS);
  while (!signal.aborted && Date.now() < deadline) {
    const view = await port.task(taskId).catch(() => undefined);
    const session = view?.sessions[0];
    if (session) return { sessionId: session.sessionId };
    // Задача кончилась, не открыв сессии (отказ дороги): ждать нечего. Причину ядро пишет в шаг
    // («session road refused: tools-none-unsupported …») — её и называем, а не общее «нет сессии».
    if (view?.ended) {
      const reason = view.steps.map((step) => step.reason).find(Boolean);
      return reason ? { reason } : {};
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? SESSION_POLL_MS));
  }
  return {};
}

/**
 * Поиск инструментов MCP: ядро оставляет CLI только его (`--tools ToolSearch`), чтобы модель
 * нашла инструменты моста; это служба, не действие, и в ленту не идёт.
 */
const SERVICE_TOOLS = new Set(['ToolSearch']);

function eventOf(
  event: SessionStreamEvent,
  names: Map<string, string>,
): CoreAskEvent | { kind: 'foreign-tool'; name: string } | null {
  const data = (event.data ?? {}) as Record<string, unknown>;
  switch (event.kind) {
    case 'assistant-text':
      return typeof data.text === 'string' ? { kind: 'text', text: data.text } : null;
    case 'tool-call': {
      const name = String(data.name ?? '');
      const match = BRIDGE_TOOL.exec(name);
      if (!match) return SERVICE_TOOLS.has(name) ? null : { kind: 'foreign-tool', name };
      names.set(String(data.toolUseId ?? ''), match[1]!);
      return { kind: 'tool', name: match[1]! };
    }
    case 'tool-result': {
      const name = names.get(String(data.toolUseId ?? ''));
      return name ? { kind: 'tool-result', name, isError: data.isError === true } : null;
    }
    case 'turn-end':
      if (data.isError !== true) return { kind: 'done', reply: '' };
      // Слова CLI об ошибке (отказ модели, HTTP 400) доходят дословно и кода не получают; без
      // слов — своя строка панели с кодом, окно переводит её на язык интерфейса.
      return typeof data.text === 'string' && data.text.trim()
        ? { kind: 'error', message: data.text }
        : { kind: 'error', message: serverText('panel-agent-model-error') };
    case 'error':
      return { kind: 'error', message: String(data.detail ?? data.code ?? 'session error') };
    default:
      return null;
  }
}

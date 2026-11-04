import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { SSE_PING_MS } from '@agentdeck/contracts/core/panel-api';
import {
  SESSION_STREAM_SSE_EVENT,
  sessionEventKeys,
  type SessionStreamPage,
} from '@agentdeck/contracts/core/session-stream';
import type { StreamNormaliser } from '../adapters/adapter.types.ts';
import { NoSessionView } from '../adapters/rpc-stdio/rpc-view.ts';
import { replaySession, sessionStamp } from '../adapters/sdk-stream/stream-view.ts';
import type { TaskFoldState } from '../journal/reduce/reduce.types.ts';
import { apiError } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';
import { readTask } from './task-read.ts';

/**
 * `GET /v1/tasks/:id/sessions/:sid/stream?from=<смещение>` (этап 10) — вид сеанса для чата
 * панели: текст разговора в журнал задачи не попадает (01), он читается с диска сеанса через
 * нормализатор того переходника, что запускал сеанс (`session.started.adapter`). Каталог —
 * `<задача>/sessions/<sid>`, то же правило, что у запуска (`sessionDirOf`). Отказы по имени: 501
 * `no-normaliser` — у переходника вида нет вовсе; 501 `no-view` — у этого сеанса нет входа вида
 * (CLI JSON-RPC, запущенный до записи `rpc-view.json`).
 *
 * Два вида ответа. Обычный — одна страница JSON с курсором `next`. С `Accept: text/event-stream`
 * — поток: кадр `page` на каждую новую порцию (`id:` = курсор `next`), пока сеанс жив; конец
 * сеанса, дочитанный до конца, — последний кадр с `done: true` и закрытие. Обрыв (перезапуск
 * панели, сон ноутбука) возобновляется по `Last-Event-ID` = последний курсор: ни один ход не
 * теряется, ход на границе курсора отсеивается по ключу (`sessionEventKeys`).
 */

const SESSIONS_DIR = 'sessions';
/** Шаг опроса диска сеанса; перечитывается только сдвинувшийся сеанс (`sessionStamp`). */
export const SESSION_FOLLOW_MS = 250;

const isEnded = (state: TaskFoldState | undefined, sid: string): boolean => {
  const s = state?.sessions[sid];
  return s?.state === 'ended' || s?.state === 'lost';
};

/**
 * Поток просят заголовком или `?follow=1`: прокси панели пересылает адрес с запросом и
 * `Last-Event-ID`, но не `Accept` — `follow` доходит до ядра через любое звено.
 */
function wantsStream(request: FastifyRequest<{ Querystring: { follow?: string } }>): boolean {
  if (request.query.follow === '1') return true;
  const accept = request.headers.accept;
  return typeof accept === 'string' && accept.includes('text/event-stream');
}

/** Курсор потока: `Last-Event-ID` главнее адреса (повтор EventSource шлёт тот же адрес). */
function cursorOf(request: FastifyRequest<{ Querystring: { from?: string } }>): number | null {
  const header = request.headers['last-event-id'];
  const raw = (Array.isArray(header) ? header[0] : header) ?? request.query.from ?? '0';
  const from = Number(raw);
  return Number.isSafeInteger(from) && from >= 0 ? from : null;
}

export interface SessionFollowDeps {
  dir: string;
  normaliser: () => StreamNormaliser;
  ended: () => boolean;
  pingMs?: number;
  stepMs?: number;
}

/**
 * Ведёт поток вида в сырой ответ до конца сеанса или ухода клиента. Ответ — функция снятия
 * (тест и закрытие сервера). Нечитаемый сеанс — кадр `error` и закрытие: «пусто» без чтения
 * не говорится (F25).
 */
export function followSession(res: ServerResponse, deps: SessionFollowDeps, from: number) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': open\n\n');
  let cursor = from;
  let stamp = '';
  // Ключи уже отданных событий на смещении курсора и дальше: повтор хода на границе не уходит.
  let sent = new Set<string>();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const ping = setInterval(() => res.write(': ping\n\n'), deps.pingMs ?? SSE_PING_MS);
  ping.unref?.();
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    if (timer) clearTimeout(timer);
    res.end();
  };
  res.on('close', close);
  const frame = (event: string, id: number | null, data: unknown): void => {
    const head = id === null ? '' : `id: ${id}\n`;
    res.write(`${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const tick = (): void => {
    if (closed) return;
    // Конец сеанса читается ДО диска: строка конца легла — всё, что хост написал, уже на диске.
    const ended = deps.ended();
    const now = sessionStamp(deps.dir);
    if (now !== stamp || ended) {
      stamp = now;
      let page;
      try {
        page = replaySession(deps.dir, deps.normaliser(), cursor);
      } catch (error) {
        frame('error', null, { code: 'stream-unreadable', detail: String(error) });
        close();
        return;
      }
      const keys = sessionEventKeys(page.events);
      const fresh = page.events.filter((_, i) => !sent.has(keys[i] as string));
      const next = Math.max(page.next, cursor);
      const done = ended && page.next === page.size;
      if (fresh.length > 0 || next !== cursor || done) {
        if (next !== cursor) sent = new Set();
        for (let i = 0; i < page.events.length; i += 1) {
          if ((page.events[i]?.offset ?? -1) >= next) sent.add(keys[i] as string);
        }
        cursor = next;
        frame(SESSION_STREAM_SSE_EVENT, cursor, { events: fresh, next: cursor, done });
      }
      if (done) {
        close();
        return;
      }
    }
    timer = setTimeout(tick, deps.stepMs ?? SESSION_FOLLOW_MS);
    timer.unref?.();
  };
  tick();
  return close;
}

function sessionOf(
  ctx: RouteContext,
  reply: FastifyReply,
  taskId: string,
  sid: string,
  dir: string,
): { state: TaskFoldState; normaliser: () => StreamNormaliser } | undefined {
  const task = readTask(ctx.registry, taskId, reply);
  if (!task) return undefined;
  const session = task.state.sessions[sid];
  if (!session) {
    void reply.code(404).send(apiError('unknown-session', 'Сеанса нет в этой задаче'));
    return undefined;
  }
  const adapter = ctx.adapters?.get(session.adapter);
  if (!adapter?.streamNormaliser) {
    void reply
      .code(501)
      .send(apiError('no-normaliser', `У переходника ${session.adapter} нет вида сеанса`));
    return undefined;
  }
  const make = (): StreamNormaliser => adapter.streamNormaliser!(dir);
  try {
    // Проба до ответа: сеанс без входа вида (запущен до его записи) — названный отказ, не
    // пустая страница и не «нечитаемо».
    make();
  } catch (error) {
    if (!(error instanceof NoSessionView)) throw error;
    void reply.code(501).send(apiError('no-view', error.message));
    return undefined;
  }
  return { state: task.state, normaliser: make };
}

export function registerSessionStream(app: FastifyInstance, ctx: RouteContext): void {
  app.get<{ Params: { id: string; sid: string }; Querystring: { from?: string; follow?: string } }>(
    '/v1/tasks/:id/sessions/:sid/stream',
    async (request, reply) => {
      if (!ctx.requireRead(request, reply)) return reply;
      const { id: taskId, sid } = request.params;
      const from = cursorOf(request);
      if (from === null) {
        return reply.code(400).send(apiError('bad-offset', 'from — неотрицательное целое'));
      }
      const dir = join(ctx.registry.tasksDir, taskId, SESSIONS_DIR, sid);
      const found = sessionOf(ctx, reply, taskId, sid, dir);
      if (!found) return reply;
      if (wantsStream(request)) {
        reply.hijack();
        followSession(
          reply.raw,
          {
            dir,
            normaliser: found.normaliser,
            ended: () => {
              try {
                return isEnded(ctx.registry.view(taskId), sid);
              } catch {
                return false;
              }
            },
          },
          from,
        );
        return reply;
      }
      try {
        const page = replaySession(dir, found.normaliser(), from);
        const body: SessionStreamPage = {
          taskId,
          sessionId: sid,
          adapter: found.state.sessions[sid]?.adapter ?? '',
          events: page.events,
          next: Math.max(page.next, from),
          done: isEnded(found.state, sid) && page.next === page.size,
        };
        return body;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return reply.code(500).send(apiError('stream-unreadable', reason));
      }
    },
  );
}

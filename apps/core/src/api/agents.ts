import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import {
  agentsQuerySchema,
  type AgentNodeDetail,
  type AgentsListReply,
  type AgentsQuery,
  type AgentsStreamEvent,
  type AgentTreeView,
} from '@agentdeck/contracts/core/agents';
import { commandIssues } from '@agentdeck/contracts/core/commands';
import { SSE_PING_MS } from '@agentdeck/contracts/core/panel-api';
import { apiError } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * Дерево агентов (этап 11, P146-P147): `GET /v1/tasks/:id/agents` — дерево задачи с фильтрами,
 * `…/agents/:nodeId` — узел подробно (вызовы постранично), `…/agents/stream` — поток изменений
 * (SSE), `…/agents/export` — замаскированный срез журнала (jsonl), `GET /v1/agents` — узлы всех
 * задач (группа, разговор). Всё — свёртка журнала порта; порта нет — 501, не пустое дерево.
 * Порт и поток даёт свёртка (`bootstrap/agents-wiring`); задачи нет — 404 до заголовков потока.
 */

export interface AgentsPort {
  /** `undefined` — задачи нет (404). */
  tree(taskId: string, query: AgentsQuery): AgentTreeView | undefined;
  /** `undefined` — задачи или узла нет (404). `page` — курсор страницы вызовов. */
  node(taskId: string, nodeId: string, page: string | null): AgentNodeDetail | undefined;
  list(query: AgentsQuery): AgentsListReply;
  /** Замаскированный срез журнала задачи, строки jsonl; `undefined` — задачи нет. */
  exportSlice(taskId: string): string | undefined;
  /**
   * Поток дерева: `after === null` — снимок, потом кадры узлов; иначе — кадры узлов по строкам
   * после `after` (повтор пропущенного), потом живые. Конец задачи — кадр `end`, поток закрыт.
   * Ответ — отписка; `undefined` — задачи нет (404).
   */
  follow(
    taskId: string,
    after: number | null,
    send: (event: AgentsStreamEvent) => void,
  ): (() => void) | undefined;
}

/** Курсор потока: `Last-Event-ID` (переподключение EventSource) главнее `?after=`; нет — `null`. */
export function streamAfter(header: string | string[] | undefined, query: unknown): number | null {
  const raw = Array.isArray(header) ? header[0] : header;
  const q = query && typeof query === 'object' ? (query as Record<string, unknown>) : {};
  const value = raw ?? q.after;
  if (value === undefined || value === '') return null;
  // Только цифры: `Number(' ')` — это 0, `Number('1e3')` — 1000; такой курсор — ошибка, не начало.
  return typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : Number.NaN;
}

/**
 * Курсор страницы вызовов узла: нет или пусто — первая страница (`null`), цифры — он сам, прочее
 * (`abc`, `1e3`, `-1`, повтор ключа) — `undefined`, маршрут отвечает 400, а не тихо первой страницей.
 */
export function pageCursor(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === '') return null;
  return typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? raw : undefined;
}

const seqOfEvent = (event: AgentsStreamEvent): number =>
  event.type === 'snapshot' ? event.view.seq : event.seq;

/**
 * Поток кадров дерева (SSE, приём `api/sse.ts`): `id:` = `seq` строки, `event:` = тип кадра,
 * `: ping` по шагу контракта. Кадр `end` закрывает поток.
 */
function openAgentsSse(
  res: ServerResponse,
  pingMs: number,
  onClose: () => void,
): { send(event: AgentsStreamEvent): void; close(): void; readonly closed: boolean } {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': open\n\n');
  let closed = false;
  const ping = setInterval(() => res.write(': ping\n\n'), pingMs);
  ping.unref?.();
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    onClose();
    res.end();
  };
  res.on('close', close);
  return {
    send(event) {
      if (closed) return;
      res.write(
        `id: ${seqOfEvent(event)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
      if (event.type === 'end') close();
    },
    close,
    get closed() {
      return closed;
    },
  };
}

const notImplemented = () => apiError('not-implemented', 'История агентов не подключена');
const noTask = () => apiError('no-task', 'Задачи нет');

export function registerAgents(
  app: FastifyInstance,
  ctx: RouteContext,
  port: () => AgentsPort | undefined,
): void {
  /** Фильтры строки запроса; неизвестный ключ или значение — 400 с путём, а не тихий фильтр. */
  const queryOf = (
    raw: unknown,
  ): { ok: true; query: AgentsQuery } | { ok: false; body: object } => {
    const parsed = agentsQuerySchema.safeParse(raw ?? {});
    if (parsed.success) return { ok: true, query: parsed.data };
    return {
      ok: false,
      body: apiError('bad-query', 'Фильтры агентов не прошли разбор', {
        issues: commandIssues(parsed.error.issues, 'query', raw),
      }),
    };
  };

  app.get<{ Params: { id: string } }>('/v1/tasks/:id/agents', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const agents = port();
    if (!agents) return reply.code(501).send(notImplemented());
    const q = queryOf(request.query);
    if (!q.ok) return reply.code(400).send(q.body);
    return agents.tree(request.params.id, q.query) ?? reply.code(404).send(noTask());
  });

  app.get<{ Params: { id: string } }>('/v1/tasks/:id/agents/stream', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const agents = port();
    if (!agents) return reply.code(501).send(notImplemented());
    const after = streamAfter(request.headers['last-event-id'], request.query);
    if (Number.isNaN(after))
      return reply.code(400).send(apiError('bad-query', 'Курсор потока — целое число ≥ 0'));
    // Задачи нет — 404 до заголовков потока: узнать это можно только попыткой подписки.
    const queued: AgentsStreamEvent[] = [];
    const sink: { send: (e: AgentsStreamEvent) => void } = { send: (e) => queued.push(e) };
    const off = agents.follow(request.params.id, after, (e) => sink.send(e));
    if (!off) return reply.code(404).send(noTask());
    reply.hijack();
    const stream = openAgentsSse(reply.raw, SSE_PING_MS, off);
    sink.send = (e) => stream.send(e);
    for (const e of queued) stream.send(e);
    return reply;
  });

  app.get<{ Params: { id: string } }>('/v1/tasks/:id/agents/export', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const agents = port();
    if (!agents) return reply.code(501).send(notImplemented());
    const slice = agents.exportSlice(request.params.id);
    if (slice === undefined) return reply.code(404).send(noTask());
    return reply.type('application/x-ndjson; charset=utf-8').send(slice);
  });

  app.get<{ Params: { id: string; nodeId: string }; Querystring: { page?: string } }>(
    '/v1/tasks/:id/agents/:nodeId',
    async (request, reply) => {
      if (!ctx.requireRead(request, reply)) return reply;
      const agents = port();
      if (!agents) return reply.code(501).send(notImplemented());
      const page = pageCursor(request.query.page);
      if (page === undefined)
        return reply
          .code(400)
          .send(apiError('bad-page', 'Курсор страницы вызовов — целое число ≥ 0'));
      const detail = agents.node(request.params.id, request.params.nodeId, page);
      return detail ?? reply.code(404).send(apiError('node-not-found', 'Узла агента нет'));
    },
  );

  app.get('/v1/agents', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const agents = port();
    if (!agents) return reply.code(501).send(notImplemented());
    const q = queryOf(request.query);
    if (!q.ok) return reply.code(400).send(q.body);
    return agents.list(q.query);
  });
}

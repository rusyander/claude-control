import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  HopActivity,
  HopControlReply,
  HopControlRequest,
} from '@agentdeck/contracts/core/hops';
import { SSE_PING_MS } from '@agentdeck/contracts/core/panel-api';
import { apiError } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * Работа своей модели вне задач (этап 11, P150): `GET /v1/local/activity` — снимок того, что
 * сейчас делает сервер модели за звеном (загрузка, разбор запроса n/всего, генерация), и
 * `GET /v1/local/activity/stream` — поток тех же кадров. Источник — управляющий канал хоста
 * звеньев (op `activity`): опрос `/health` + `/slots` ведёт сам хост и только пока запрос в
 * полёте; ядро лишь спрашивает хост. Вид летучий, в журнал не пишется.
 *
 * Отказы: нет порта — 501 (хост не подключён); хост ответил отказом (прежняя версия хоста не
 * знает op `activity`) — 501 с другим текстом; хост не ответил — 503 (поднимается или упал).
 */

export interface LocalActivityPort {
  /** Управляющий запрос к хосту звеньев этой загрузки (тот же, что у `clear-exhausted`). */
  control(request: HopControlRequest): Promise<HopControlReply>;
  /** Шаг, с которым поток спрашивает хост (по умолчанию 500 мс; тесты сокращают). */
  pollMs?: number;
}

const POLL_MS = 500;

/** Нет порта — хост звеньев не подключён; есть — в его канале нет кадра `activity`. */
const notImplemented = (wired: boolean) =>
  apiError(
    'not-implemented',
    wired
      ? 'Хост звеньев не отдаёт активность своей модели'
      : 'Активность своей модели не подключена',
  );

type Read = { routes: HopActivity[] } | { status: 501 | 503; body: ReturnType<typeof apiError> };

async function readActivity(port: LocalActivityPort): Promise<Read> {
  let reply: HopControlReply;
  try {
    reply = await port.control({ op: 'activity' });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: 503,
      body: apiError('hops-unreachable', 'Хост звеньев не ответил', { detail }),
    };
  }
  if (reply.op !== 'activity' || !reply.ok) return { status: 501, body: notImplemented(true) };
  return { routes: reply.routes };
}

const frame = (routes: HopActivity[]): string =>
  `event: activity\ndata: ${JSON.stringify({ routes })}\n\n`;

/**
 * Поток: кадр сразу, дальше — только когда вид сменился. Хост между шагами не ответил —
 * шаг пропущен (поток не рвётся: хост перезапускается, панель увидит прежний кадр), пинг идёт.
 */
function stream(reply: FastifyReply, port: LocalActivityPort, first: HopActivity[]): void {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let last = JSON.stringify(first);
  res.write(frame(first));
  let busy = false;
  const poll = setInterval(() => {
    if (busy) return;
    busy = true;
    void readActivity(port)
      .then((read) => {
        if (!('routes' in read) || res.destroyed) return;
        const next = JSON.stringify(read.routes);
        if (next === last) return;
        last = next;
        res.write(frame(read.routes));
      })
      .finally(() => {
        busy = false;
      });
  }, port.pollMs ?? POLL_MS);
  const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS);
  poll.unref();
  ping.unref();
  res.on('close', () => {
    clearInterval(poll);
    clearInterval(ping);
  });
}

export function registerLocalActivity(
  app: FastifyInstance,
  ctx: RouteContext,
  port: () => LocalActivityPort | undefined,
): void {
  app.get('/v1/local/activity', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const own = port();
    if (!own) return reply.code(501).send(notImplemented(false));
    const read = await readActivity(own);
    if (!('routes' in read)) return reply.code(read.status).send(read.body);
    return reply.header('cache-control', 'no-store').send({ routes: read.routes });
  });

  app.get('/v1/local/activity/stream', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const own = port();
    if (!own) return reply.code(501).send(notImplemented(false));
    // Первый кадр — до заголовков потока: отказ хоста — честный статус, а не пустой поток.
    const read = await readActivity(own);
    if (!('routes' in read)) return reply.code(read.status).send(read.body);
    stream(reply, own, read.routes);
    return reply;
  });
}

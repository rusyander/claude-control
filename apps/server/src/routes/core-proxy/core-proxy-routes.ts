import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CORE_API_PREFIX,
  CORE_PANEL_ROUTES,
  PANEL_CORE_PREFIX,
  type CorePanelRoute,
} from '@agentdeck/contracts/core/panel-api';
import {
  forwardToCore,
  locateCore,
  verifyCore,
  type CoreForward,
  type CoreLocation,
} from '../../domains/core-proxy/core-proxy.ts';
import { hopGateFromEnv, type HopGate } from '../../domains/core-proxy/hop-gate.ts';
import { coreHomeOf } from '../../lib/hop-recorder.mjs';
import {
  createCoreIdentityDeps,
  type CoreIdentityDeps,
} from '../../lib/listen-identity/listen-identity.ts';
import { ownerOf, readTcpTable, type TcpRow } from '../../lib/peer-process/peer-process.ts';
import { serverText } from '../../lib/server-texts/server-texts.ts';
import { CLIENT_PORT_HEADER } from '../chat/human-only/human-only.ts';

/**
 * Прокладка панели к ядру (07, этап 9): ручки — ОДИН список контрактов `CORE_PANEL_ROUTES`,
 * здесь только пересылка `/api/core<path>` → `/v1<path>`. Прокладка числа страницы не делает,
 * полномочий не судит и ничего не пишет — её перезапуск посреди прогона не меняет ни строки
 * журнала (P23).
 *
 * Bearer ядра уходит только строке `procs.json`, которую подтвердила ОС (F10, F-19): порт строки
 * слушает её pid, и он жив с тем же стартом. Иначе — 503 `core-unverified`, запрос не отправлен.
 *
 * pid пира (только POST — команды и записи, которые ядро судит по полномочиям): владелец сокета
 * по таблице TCP; за прокси Vite — владелец порта из заголовка клиента, если этот порт
 * действительно принял сосед (та же проверка, что у ворот человека). Заголовок
 * `x-agentdeck-peer-pid` от клиента не пробрасывается: его ставит только прокладка.
 *
 * Поток событий задачи (`stream: true`) идёт насквозь, без накопления: лента живёт часами, а
 * `Last-Event-ID` браузера доезжает до ядра — возобновление с последней полученной строки.
 */

export interface CoreProxyDeps {
  home(): string;
  /** Таблица TCP с владельцами; `undefined` — ОС не ответила. */
  readTcp(wanted: ReadonlySet<number>): Promise<TcpRow[] | undefined>;
  /** Чтения ОС для сверки строки ядра; нет — настоящие чтения этой машины. */
  identity?: (port: number) => CoreIdentityDeps;
  /**
   * Ворота записи звена (P131): POST ждёт, пока сторож запишет этот сервер ядру с каналом
   * строки. Нет — сервер запущен без сторожа, ждать некого.
   */
  hopGate?: HopGate;
}

const firstHeader = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/** pid того, кто прислал запрос; 0 — не узнали (ядро тогда требует подпись устройства). */
export async function requesterPid(
  request: Pick<FastifyRequest, 'headers' | 'socket'>,
  readTcp: CoreProxyDeps['readTcp'],
): Promise<number> {
  const peerPort = request.socket.remotePort;
  const serverPort = request.socket.localPort;
  if (!peerPort || !serverPort) return 0;
  const hopRaw = Number(firstHeader(request.headers[CLIENT_PORT_HEADER]));
  const hop = Number.isInteger(hopRaw) && hopRaw > 0 && hopRaw < 65_536 ? hopRaw : undefined;
  const tcp = await readTcp(new Set(hop ? [peerPort, hop] : [peerPort]));
  if (!tcp) return 0;
  const peer = ownerOf(tcp, peerPort, serverPort);
  if (!peer) return 0;
  if (!hop) return peer;
  const accepted = tcp.find((row) => row.remotePort === hop && row.pid === peer);
  const client = accepted ? ownerOf(tcp, hop, accepted.localPort) : undefined;
  return client ?? peer;
}

type RefusalCode = 'core-absent' | 'core-unverified' | 'core-unreachable';

function refuse(reply: FastifyReply, status: number, code: RefusalCode, detail: string) {
  return reply.code(status).send({ error: serverText(code), code, messageCode: code, detail });
}

/** Путь ядра с подставленными параметрами и тем же запросом (`?page=…`), что пришёл к панели. */
export function corePathOf(route: CorePanelRoute, request: Pick<FastifyRequest, 'params' | 'url'>) {
  const params = (request.params ?? {}) as Record<string, string>;
  const path = route.path.replace(/:([A-Za-z]+)/g, (_, name: string) =>
    encodeURIComponent(params[name] ?? ''),
  );
  const at = request.url.indexOf('?');
  return `${CORE_API_PREFIX}${path}${at >= 0 ? request.url.slice(at) : ''}`;
}

/** Строка найдена и подтверждена — или уже отправленный отказ. */
async function verifiedCore(
  reply: FastifyReply,
  deps: CoreProxyDeps,
  identity: (port: number) => CoreIdentityDeps,
): Promise<CoreLocation | undefined> {
  const core = locateCore(deps.home());
  if ('missing' in core) {
    await refuse(reply, 503, 'core-absent', core.missing);
    return undefined;
  }
  const os = identity(core.entry.port);
  const proven = await verifyCore(core, os);
  if ('value' in proven) return core;
  const reason = 'unknown' in proven ? proven.unknown : 'absent';
  // Процесса строки нет вовсе (ядро убито, строка осталась) — ядро не запущено, а не
  // самозванец: человеку нужна карточка «запустите ядро». Токен не ушёл в обоих случаях.
  if ((await os.exists(core.entry.pid)) === false) {
    await refuse(reply, 503, 'core-absent', `core pid ${core.entry.pid} is gone: ${reason}`);
    return undefined;
  }
  await refuse(reply, 503, 'core-unverified', reason);
  return undefined;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Обычная ручка: ответ ядра целиком, с его статусом и типом. */
async function relayOnce(reply: FastifyReply, core: CoreLocation, call: CoreForward) {
  let got: Response;
  let text: string;
  try {
    got = await forwardToCore(core, call);
    text = await got.text();
  } catch (error) {
    return refuse(reply, 502, 'core-unreachable', reasonOf(error));
  }
  reply.code(got.status);
  const type = got.headers.get('content-type');
  if (type) reply.type(type);
  return reply.send(text);
}

/**
 * Поток событий: ответ отдаётся сырым сокетом (`hijack`) — ни один хук ответа не копит тело.
 * Клиент ушёл — запрос к ядру обрывается, ядро освобождает подписку.
 */
async function relayStream(
  request: FastifyRequest,
  reply: FastifyReply,
  core: CoreLocation,
  call: CoreForward,
) {
  const abort = new AbortController();
  request.raw.once('close', () => abort.abort());
  let got: Response;
  try {
    got = await forwardToCore(core, { ...call, signal: abort.signal });
  } catch (error) {
    return refuse(reply, 502, 'core-unreachable', reasonOf(error));
  }
  reply.hijack();
  const headers: Record<string, string | number | string[]> = {};
  for (const [name, value] of Object.entries(reply.getHeaders()))
    if (value !== undefined) headers[name] = value;
  headers['content-type'] = got.headers.get('content-type') ?? 'text/event-stream';
  headers['cache-control'] = 'no-cache, no-transform';
  // nginx и подобные прокси иначе копят поток событий до конца ответа.
  headers['x-accel-buffering'] = 'no';
  reply.raw.writeHead(got.status, headers);
  reply.raw.flushHeaders();
  if (!got.body) {
    reply.raw.end();
    return;
  }
  const body = Readable.fromWeb(got.body as WebReadableStream<Uint8Array>);
  body.on('error', () => reply.raw.end());
  reply.raw.once('close', () => body.destroy());
  body.pipe(reply.raw);
}

export function createCoreProxyRoutes(deps: CoreProxyDeps) {
  const identity = deps.identity ?? createCoreIdentityDeps();
  return (app: FastifyInstance): void => {
    for (const route of CORE_PANEL_ROUTES as readonly CorePanelRoute[]) {
      app.route({
        method: route.method,
        url: `${PANEL_CORE_PREFIX}${route.path}`,
        handler: async (request, reply) => {
          const core = await verifiedCore(reply, deps, identity);
          if (!core) return reply;
          const call: CoreForward = { method: route.method, path: corePathOf(route, request) };
          if (route.method === 'POST') {
            // Команда не обгоняет запись звена сторожем: иначе первая команда после запуска
            // панели (или ядра) получила бы отказ пира, хотя запись вот-вот ляжет.
            if (deps.hopGate && core.entry.supervisor) await deps.hopGate(core.entry.supervisor);
            call.body = request.body ?? {};
            call.peerPid = await requesterPid(request, deps.readTcp);
          }
          if (route.stream) {
            const lastEventId = firstHeader(request.headers['last-event-id']);
            if (lastEventId !== undefined) call.lastEventId = lastEventId;
            await relayStream(request, reply, core, call);
            return reply;
          }
          return relayOnce(reply, core, call);
        },
      });
    }
  };
}

/** Прокладка этого процесса: дом ядра и ворота записи звена — из окружения, что дал сторож. */
export function registerCoreProxyRoutes(app: FastifyInstance): void {
  const hopGate = hopGateFromEnv();
  createCoreProxyRoutes({
    home: () => coreHomeOf(),
    readTcp: (wanted) => readTcpTable(wanted),
    ...(hopGate ? { hopGate } : {}),
  })(app);
}

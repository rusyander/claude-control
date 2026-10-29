import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  coreHomeOf,
  forwardToCore,
  locateCore,
  type CoreForward,
} from '../../domains/core-proxy/core-proxy.ts';
import { ownerOf, readTcpTable, type TcpRow } from '../../lib/peer-process/peer-process.ts';
import { CLIENT_PORT_HEADER } from '../chat/human-only/human-only.ts';

/**
 * Прокладка панели к ядру, фаза 2 (07, 06 §Authority): носит число страницы, которое
 * ЧЕКАНИТ ЯДРО (`GET /v1/nonce`), и pid процесса, приславшего команду. Сама она числа не
 * делает, полномочий не судит и ничего не пишет — поэтому её перезапуск посреди прогона не
 * меняет ни строки журнала (P23).
 *
 * pid пира: владелец сокета по таблице TCP; за прокси Vite — владелец порта из заголовка
 * клиента, если этот порт действительно принял сосед (та же проверка, что у ворот человека).
 * Заголовок `x-agentdeck-peer-pid` от клиента не пробрасывается: его ставит только прокладка.
 */

export interface CoreProxyDeps {
  home(): string;
  /** Таблица TCP с владельцами; `undefined` — ОС не ответила. */
  readTcp(wanted: ReadonlySet<number>): Promise<TcpRow[] | undefined>;
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

async function relay(reply: FastifyReply, home: string, call: CoreForward) {
  const core = locateCore(home);
  if ('missing' in core) {
    return reply
      .code(503)
      .send({ error: 'core is not running', code: 'core-absent', detail: core.missing });
  }
  try {
    const got = await forwardToCore(core, call);
    return reply.code(got.status).send(got.body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return reply
      .code(502)
      .send({ error: 'core does not answer', code: 'core-unreachable', detail });
  }
}

export function createCoreProxyRoutes(deps: CoreProxyDeps) {
  return (app: FastifyInstance): void => {
    app.get<{ Querystring: { page?: string } }>('/api/core/nonce', (request, reply) =>
      relay(reply, deps.home(), {
        method: 'GET',
        path: `/v1/nonce?page=${encodeURIComponent(request.query.page ?? '')}`,
      }),
    );
    app.get('/api/core/tasks', (_request, reply) =>
      relay(reply, deps.home(), { method: 'GET', path: '/v1/tasks' }),
    );
    app.get<{ Params: { id: string } }>('/api/core/tasks/:id', (request, reply) =>
      relay(reply, deps.home(), {
        method: 'GET',
        path: `/v1/tasks/${encodeURIComponent(request.params.id)}`,
      }),
    );
    app.post('/api/core/commands', async (request, reply) => {
      const peerPid = await requesterPid(request, deps.readTcp);
      return relay(reply, deps.home(), {
        method: 'POST',
        path: '/v1/commands',
        body: request.body,
        peerPid,
      });
    });
  };
}

export function registerCoreProxyRoutes(app: FastifyInstance): void {
  createCoreProxyRoutes({ home: () => coreHomeOf(), readTcp: (wanted) => readTcpTable(wanted) })(
    app,
  );
}

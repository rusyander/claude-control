import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CommandEnv } from '../conductor/commands.ts';
import type { TaskRegistry } from '../conductor/tasks.ts';
import type { NonceStore } from '../policy/authority/nonce.ts';
import type { PeerDeps, SignatureDeps, TokenClass } from './auth.ts';

/**
 * Что `buildApi` даёт ручке, живущей в своём модуле (этап 4: `/v1/estimate` — зона D,
 * `/v1/scenarios` — зона A): зона правит свой модуль и не трогает `server.ts`. Доказательство
 * человека собирается из тех же частей, что у `/v1/commands` — число страницы, пир, подпись.
 */
export interface RouteContext {
  registry: TaskRegistry;
  /**
   * Та же среда, что у `/v1/commands`: дом ядра (библиотека сценариев) и порт среды деления —
   * `undefined`, пока дирижёр не запущен (ручка оценки тогда 501 «не подключена»).
   */
  env: CommandEnv;
  /** Токен ядра или Bearer панели; иначе 401 уже отправлен и вернулось `undefined`. */
  requireRead(request: FastifyRequest, reply: FastifyReply): TokenClass | undefined;
  tokenOf(request: FastifyRequest): TokenClass;
  proof: {
    nonces: NonceStore;
    peer: PeerDeps;
    signature: SignatureDeps;
    seen: { claim(key: string): boolean };
  };
  now: () => number;
}

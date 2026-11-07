import type { FastifyInstance } from 'fastify';
import type { AllocatorView } from '@agentdeck/contracts/core/records';
import { apiError } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * Распределитель мест сеансов (этап 11, P141): `GET /v1/allocator` — ёмкость (профиль,
 * `queue.sessionSlots`, действующая), кто держит место, кто ждёт и почему, сеансы чатов вне счёта.
 * Аренды общие для всех ядер и сборок машины (очередь машины `machineQueueDir`: по умолчанию
 * `~/.agentdeck/machine/queue`, у перенесённого дома — `<home>/queue`); порт даёт
 * `bootstrap/allocator-wiring`.
 * Порта нет — 501, а не «мест сколько угодно».
 */

export interface AllocatorPort {
  view(): AllocatorView;
}

export function registerAllocator(
  app: FastifyInstance,
  ctx: RouteContext,
  port: () => AllocatorPort | undefined,
): void {
  app.get('/v1/allocator', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const allocator = port();
    if (!allocator) {
      return reply
        .code(501)
        .send(apiError('not-implemented', 'Распределитель мест сеансов не подключён'));
    }
    return allocator.view();
  });
}

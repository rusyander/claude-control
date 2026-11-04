import { isAbsolute } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DELIVERY_NOT_A_COPY } from '@agentdeck/contracts/core/publish';
import { publisherOf } from '../conductor/commands/publisher-port.ts';
import { apiError } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * `GET /v1/delivery?copy=<абсолютный путь копии>` — проба сдачи копии единицы тем же судом, что
 * шаг публикации (`publish-wiring/delivery-probe.ts`). Чтение: токен ядра или Bearer панели;
 * проба ничего не пушит и в журнал не пишет. Читает её `tests-cli delivery` через панель
 * (`/api/core/delivery`) — других проверок сдачи у панели нет.
 */
export function registerDelivery(app: FastifyInstance, ctx: RouteContext): void {
  app.get<{ Querystring: { copy?: string } }>('/v1/delivery', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const copy = typeof request.query.copy === 'string' ? request.query.copy.trim() : '';
    if (copy === '' || !isAbsolute(copy)) {
      return reply
        .code(400)
        .send(apiError('copy-required', 'Нужен абсолютный путь копии: ?copy=<папка>'));
    }
    const publisher = publisherOf(ctx.env);
    if (!publisher) {
      return reply
        .code(501)
        .send(apiError('publisher-unwired', 'Публикатор ядра не подключён (дирижёр не запущен)'));
    }
    const got = await publisher.delivery(copy);
    if ('missing' in got) {
      return reply.code(404).send(apiError(DELIVERY_NOT_A_COPY, got.missing));
    }
    return got;
  });
}

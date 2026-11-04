import type { FastifyInstance } from 'fastify';
import type { McpOffersReply } from '@agentdeck/contracts/core/panel-api';
import { apiError } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * `GET /v1/mcp-offers` (этап 10, s10 p9) — серверы MCP человека по CLI ядра для экрана выбора.
 * Суд — тот же, что у чтения `/v1/config`: токен ядра или Bearer панели (`requireRead`), токену
 * сессии модели — 401. Выбор пишется только `POST /v1/config` со строгим судом `set-config`.
 * Порта нет — 501, как у настройки до её зоны.
 */

export interface McpOffersPort {
  read(): McpOffersReply;
}

export function registerMcpOffers(
  app: FastifyInstance,
  ctx: RouteContext,
  port: () => McpOffersPort | undefined,
): void {
  app.get('/v1/mcp-offers', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const offers = port();
    if (!offers) {
      return reply.code(501).send(apiError('not-implemented', 'Предложения MCP ещё не подключены'));
    }
    return offers.read();
  });
}

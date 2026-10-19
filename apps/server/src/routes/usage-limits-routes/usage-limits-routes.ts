import type { FastifyInstance } from 'fastify';
import { sendConditional } from '../../lib/conditional-get/conditional-get.ts';
import type { UsageLimitsMonitor } from '../../domains/usage-limits/usage-limits.ts';

/**
 * `GET /api/usage-limits` — лимиты подписки для боковой панели. Ответ из общего
 * кэша сервера (`domains/usage-limits`), с ETag: вкладка, перечитавшая маршрут
 * по событию или по своему таймеру, получает 304, пока окна не сдвинулись.
 * Токен CLI в ответ не попадает никогда — его нет в снимке вовсе.
 *
 * Монитор живёт дольше запроса и создаётся в таблице маршрутов; здесь он только
 * запускается вместе с приложением и гасится при его закрытии.
 */
export function registerUsageLimitsRoutes(app: FastifyInstance, limits: UsageLimitsMonitor): void {
  limits.start();
  app.addHook('onClose', async () => limits.stop());

  app.get('/api/usage-limits', async (request, reply) =>
    sendConditional(request, reply, await limits.get()),
  );
}

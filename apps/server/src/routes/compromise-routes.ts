import type { FastifyInstance } from 'fastify';
import type { CompromisesResponse } from '@agentdeck/contracts';
import type { ServerContext } from '../context.ts';
import { compromiseViews } from '../domains/platform/compromises.ts';

/**
 * Реестр подписанных компромиссов.
 *
 * Свой адрес, а не ветка `/api/platforms/*`: подписи принадлежат партии, а не
 * какому-то одному контуру — их ставят и тест-контур, и запросы к чужой
 * команде. Маршрут ничего не читает с диска и не ходит в сеть; живым его
 * делает не запрос, а то, что список ведёт сервер: снятая подпись гаснет на
 * экране без правки фронта.
 */
export function registerCompromiseRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  app.get('/api/compromises', () => ({ items: compromiseViews() }) satisfies CompromisesResponse);
}

import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { searchConfig } from '../domains/search.ts';

/**
 * Маршрут глобального поиска. Читающий и без побочных эффектов: агрегирует
 * разделы через их читалки и фильтрует по `q`. Пустой/короткий запрос отдаёт
 * пустой результат, секреты переменных окружения наружу не уходят.
 */
export function registerSearchRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Querystring: { q?: string } }>('/api/search', (request) =>
    searchConfig({ paths: ctx.location.paths, store: ctx.store }, request.query.q ?? ''),
  );
}

import type { FastifyInstance } from 'fastify';
import type { WatcherStatus } from '@agentdeck/contracts';
import { watchClientSignalSchema, watcherToggleBodySchema } from '@agentdeck/contracts/watcher';
import type { ServerContext } from '../context.ts';
import type { BackgroundWatcher } from '../domains/watcher/watcher.ts';
import { parseBody } from '../lib/request-body.ts';

/**
 * Фоновый наблюдатель панели.
 *
 * - `GET /api/watcher` — включён ли, с какого момента, расход, путь отчёта.
 * - `POST /api/watcher` `{ enabled }` — тумблер; выключение снимает разбор сразу.
 * - `POST /api/watcher/events` — сбой со страницы. Выключен наблюдатель —
 *   `{ accepted: false }` и ничего не пишется: страница шлёт сигналы только
 *   при включённом тумблере, но статус мог смениться между опросами.
 */
export function registerWatcherRoutes(
  app: FastifyInstance,
  _ctx: ServerContext,
  watcher: BackgroundWatcher,
): void {
  app.get('/api/watcher', (): WatcherStatus => watcher.status());

  app.post<{ Body: unknown }>('/api/watcher', (request, reply) => {
    const body = parseBody(watcherToggleBodySchema, request.body, reply);
    if (!body) return reply;
    return watcher.setEnabled(body.enabled) satisfies WatcherStatus;
  });

  app.post<{ Body: unknown }>('/api/watcher/events', (request, reply) => {
    const body = parseBody(watchClientSignalSchema, request.body, reply);
    if (!body) return reply;
    const accepted = watcher.signal({ source: 'client', ...body });
    return { accepted };
  });
}

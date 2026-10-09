import type { FastifyInstance } from 'fastify';
import type { WatchReportView, WatcherStatus } from '@agentdeck/contracts';
import {
  watchClientSignalSchema,
  watchUserReportSchema,
  watcherToggleBodySchema,
} from '@agentdeck/contracts/watcher';
import type { ServerContext } from '../../context.ts';
import type { BackgroundWatcher } from '../../domains/watcher/watcher.ts';
import { reportView } from '../../domains/watcher/report-view.ts';
import { parseBody } from '../../lib/request-body.ts';

/**
 * Фоновый наблюдатель панели.
 *
 * - `GET /api/watcher` — включён ли, с какого момента, расход, путь отчёта.
 * - `POST /api/watcher` `{ enabled }` — тумблер; выключение снимает разбор сразу.
 * - `POST /api/watcher/events` — сбой со страницы. Выключен наблюдатель —
 *   `{ accepted: false }` и ничего не пишется: страница шлёт сигналы только
 *   при включённом тумблере, но статус мог смениться между опросами.
 * - `POST /api/watcher/reports` `{ text, route? }` — баг словами человека: модель
 *   сверит его с кодом, в отчёт он ляжет только подтверждённым. Ответ — запись
 *   проверки, её исход приходит в статусе (`checks`). Выключен — 409.
 * - `GET /api/watcher/report` — отчёт разделами для страницы панели.
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

  app.post<{ Body: unknown }>('/api/watcher/reports', (request, reply) => {
    const body = parseBody(watchUserReportSchema, request.body, reply);
    if (!body) return reply;
    const check = watcher.reportBug(body);
    if (!check) {
      return reply.code(409).send({
        error: 'watcher_off',
        message: 'Наблюдатель выключен: включите его, чтобы проверить баг.',
        messageCode: 'watcher-off',
      });
    }
    return { check };
  });

  app.get('/api/watcher/report', (): WatchReportView => reportView(watcher.reportPath()));
}

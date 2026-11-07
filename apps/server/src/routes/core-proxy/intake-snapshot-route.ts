import type { FastifyInstance } from 'fastify';
import { trackerSnapshot } from '../../domains/core-intake/tracker-snapshot.ts';
import type { AtlassianAccess } from '../../domains/integrations/atlassian/client.ts';
import { guard, requireString } from '../integrations/shared.ts';

/**
 * Снимок задачи трекера для экрана запуска ядра (этап 11, P133, W3-16): форма запуска берёт
 * источник «Задача трекера» отсюда и шлёт его ядру в теле оценки (`fields.source`). Ядро в трекер
 * не ходит — читает панель, тем же доступом к Jira, что раздел «Интеграции».
 *
 * Только чтение: ни трекер, ни ядро, ни настройка здесь не меняются. Отказ Jira — тем же ответом,
 * что у прочих чтений интеграции (`guard`): «не настроено» и «не отвечает» различимы по коду.
 */

export const TRACKER_SNAPSHOT_ROUTE = '/api/core-intake/tracker-snapshot';

export interface IntakeSnapshotRouteDeps {
  /** Доступ к Jira из настроек и сохранённого ключа; не подключена — бросает отказ интеграции. */
  access: () => AtlassianAccess;
  now?: () => number;
}

export function registerIntakeSnapshotRoute(
  app: FastifyInstance,
  deps: IntakeSnapshotRouteDeps,
): void {
  app.get<{ Querystring: { key?: string } }>(TRACKER_SNAPSHOT_ROUTE, (request, reply) =>
    guard(reply, () => {
      const key = requireString(
        request.query.key,
        'key',
        'нужен ключ задачи трекера',
        'request-tracker-key-missing',
        { field: 'key' },
      );
      return trackerSnapshot(deps.access(), key, deps.now ? { now: deps.now } : {});
    }),
  );
}

import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import { groupViews } from '../../domains/groups/views.ts';
import { legacyGroupRuns } from '../../domains/groups/legacy-runs/legacy-runs.ts';

/**
 * Прежние группы — только чтение (этап 10, F1). Группы больше не запускаются, не
 * правятся и не включаются: работу ведёт ядро, а «Путь» старой группы переводит в
 * сценарий ядра `POST /api/core/scenarios/from-path`. Сетка «Прежние группы» и
 * список прежних запусков читают отсюда; маршрутов записи у групп нет.
 */
export function registerLegacyGroupsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // Пути и хранилище — на каждом обращении: каталог конфигурации меняется на лету.
  app.get('/api/groups', () =>
    groupViews({ paths: ctx.location.paths, store: ctx.store, backupDir: ctx.backupDir }),
  );

  // Прежние запуски групп: ядро их не подхватывает, недоведённые закрыты миграцией отмены.
  app.get('/api/groups/legacy-runs', () => ({ runs: legacyGroupRuns(ctx.store.getSplitPlans()) }));
}

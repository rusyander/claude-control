import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import {
  E2eRunRegistry,
  MutationChecks,
  type E2eWatch,
  type ProjectTestManualRegistry,
  type ProjectTestRunRegistry,
} from '../domains/project-tests.ts';
import { registerTestLibraryRoutes } from './project-tests/library-routes.ts';
import { registerTestPlanRoutes } from './project-tests/plan-routes.ts';
import { registerTestRunRoutes } from './project-tests/run-routes.ts';
import { registerTestManualRoutes } from './project-tests/manual-routes.ts';
import { registerTestDefectRoutes } from './project-tests/defect-routes.ts';
import { registerTestCoverageRoutes } from './project-tests/coverage-routes.ts';
import { registerProjectTestsImportRoutes } from './project-tests/import-routes.ts';
import { registerTestDraftRoutes } from './project-tests/draft-routes.ts';
import { registerTestHealthRoutes } from './project-tests/health-routes.ts';
import { registerTestReleaseRoutes } from './project-tests/release-routes.ts';
import { registerTestSecretRoutes } from './project-tests/secret-routes.ts';
import { registerTestCaseHistoryRoutes } from './project-tests/case-history-routes.ts';
import { registerTestE2eRoutes } from './project-tests/e2e-routes.ts';
import { registerTestMutationRoutes } from './project-tests/mutation-routes.ts';
import type { TestsDeps } from './project-tests/shared.ts';

/**
 * Рабочее место тестировщика: библиотека кейсов, планы, прогоны — агентом и
 * руками, — история, отчёты и дефекты.
 *
 * Каталог приходит путём, как у файлов и git проекта: вкладку открывают на
 * любой папке, и в реестре проектов её может не быть вовсе.
 *
 * Оба реестра приходят снаружи и обязательны: они живут дольше запроса, и
 * создать их должен тот, кто сможет погасить прогоны при выходе панели, —
 * `bootstrap/runtime.ts`. Значение по умолчанию молча заводило бы второй,
 * недостижимый снаружи реестр.
 *
 * Сами маршруты разложены по `project-tests/*`; здесь только сборка.
 */
export function registerProjectTestsRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  runs: ProjectTestRunRegistry,
  manual: ProjectTestManualRegistry,
  // Автотесты и наблюдение за папкой — тоже из `runtime`: раннер гаснет при
  // выходе только там. Без них (тесты маршрутов) — свой реестр и без наблюдения.
  e2e: { e2eRuns?: E2eRunRegistry; e2eWatch?: E2eWatch; mutations?: MutationChecks } = {},
): void {
  const deps: TestsDeps = {
    ctx,
    runs,
    manual,
    e2eRuns: e2e.e2eRuns ?? new E2eRunRegistry(),
    e2eWatch: e2e.e2eWatch,
    mutations: e2e.mutations ?? new MutationChecks(),
  };
  registerTestLibraryRoutes(app, deps);
  // Доступы стенда: имя в файле проекта, значение — в шифрованном хранилище.
  registerTestSecretRoutes(app, deps);
  registerTestPlanRoutes(app, deps);
  registerTestRunRoutes(app, deps);
  registerTestDraftRoutes(app, deps);
  // Линтер и таксономия только читают: ни реестры, ни каталог панели им не нужны.
  registerTestHealthRoutes(app, deps);
  // Готовность вехи ходит в Jira за требованиями — как и матрица покрытия.
  registerTestReleaseRoutes(app, deps);
  registerTestManualRoutes(app, deps);
  registerTestDefectRoutes(app, deps);
  registerTestCoverageRoutes(app, deps);
  // История кейса и отметки нестабильности только читают записи прогонов.
  registerTestCaseHistoryRoutes(app, deps);
  // Папка настоящих автотестов и её сверка с кейсами.
  registerTestE2eRoutes(app, deps);
  // Проверка набора поломкой — в копии, по кнопке человека.
  registerTestMutationRoutes(app, deps);
  // Импорт и выгрузка ходят только по пути проекта, реестры им не нужны.
  registerProjectTestsImportRoutes(app, ctx);
}

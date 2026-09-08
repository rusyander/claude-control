import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import type {
  ProjectTestManualRegistry,
  ProjectTestRunRegistry,
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
): void {
  const deps: TestsDeps = { ctx, runs, manual };
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
  // Импорт и выгрузка ходят только по пути проекта, реестры им не нужны.
  registerProjectTestsImportRoutes(app, ctx);
}

import type { ProjectTestPlan, ProjectTestPlanBuildRequest } from '@agentdeck/contracts';
import type { FastifyInstance } from 'fastify';
import {
  ProjectTestsNotFoundError,
  buildPlanPreview,
  buildPoints,
  impactOf,
  planCases,
  readEnvironments,
  readGroups,
  readPlan,
  readPlans,
  readRuns,
  removePlan,
  savePlan,
  toPlan,
} from '../../domains/project-tests.ts';
import { buildCoverage } from '../../domains/project-tests/coverage.ts';
import { guard, guardAsync, requireRoot, type TestsDeps } from './shared.ts';
import { coded } from '../../lib/server-text.ts';

/**
 * Планы и тест-поинты.
 *
 * План — это НАБОР для прогона, а не копия кейсов: он держит либо список
 * идентификаторов, либо фильтр, и в момент прогона разворачивается по текущей
 * библиотеке. Копировать кейсы в план означало бы, что исправленный кейс в
 * старом плане остаётся сломанным, и человек проверяет прошлогоднюю формулировку.
 *
 * Тест-поинт — кейс × окружение × комбинация параметров. Именно он проходится
 * и именно у него есть результат: один кейс, прогнанный на двух браузерах,
 * должен давать два независимых результата, а не затирать сам себя.
 */
export function registerTestPlanRoutes(app: FastifyInstance, deps: TestsDeps): void {
  /** Планы проекта. */
  app.get<{ Querystring: { path?: string } }>('/api/project-tests/plans', (request, reply) => {
    const root = requireRoot(request.query.path, reply);
    if (!root) return reply;
    return guard(reply, () => ({ plans: readPlans(root) }));
  });

  /** Создать или обновить план. */
  app.post<{ Body: { path?: string; plan?: Partial<ProjectTestPlan> } }>(
    '/api/project-tests/plan',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      const plan = request.body?.plan;
      if (!plan || typeof plan !== 'object' || !plan.title) {
        return reply
          .code(400)
          .send({ message: 'Нужно название плана.', messageCode: 'plan-title-required' });
      }
      return guard(reply, () => {
        const saved = savePlan(
          root,
          { ...plan, title: plan.title ?? '' },
          new Date().toISOString(),
        );
        return { plan: saved, plans: readPlans(root) };
      });
    },
  );

  /** Удалить план. Прогоны по нему остаются в истории. */
  app.delete<{ Querystring: { path?: string; id?: string } }>(
    '/api/project-tests/plan',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        removePlan(root, String(request.query.id ?? ''));
        return { plans: readPlans(root) };
      });
    },
  );

  /**
   * Собрать план правилом: «дым за N минут», «регрессия по диффу», «план вехи»,
   * «нестабильные».
   *
   * Сначала ПРЕДПРОСМОТР, и сохранение — тем же запросом с `save`. Отбор
   * считается по библиотеке «сейчас», поэтому пересобрать его на сохранении
   * дешевле и честнее, чем возить показанный список туда-обратно: план всё
   * равно сохраняется статическим списком и дальше правится руками.
   *
   * Ноль токенов: агент здесь не запускается ни на одном шаге — это счётная
   * работа, и на офлайн-машине она обязана работать так же.
   */
  app.post<{ Body: ProjectTestPlanBuildRequest & { path?: string; save?: boolean } }>(
    '/api/project-tests/plan/build',
    async (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      const body = request.body;

      return guardAsync(reply, async () => {
        const groups = readGroups(root);
        // Каждому правилу нужны свои данные, и читает их маршрут: сам сборщик
        // ничего не знает ни про файлы, ни про git, ни про Jira — потому и
        // проверяется тестом целиком.
        const preview = buildPlanPreview({
          recipe: body.recipe,
          budget: body.budget,
          release: body.release,
          threshold: body.threshold,
          environmentId: body.environmentId,
          title: body.title,
          groups,
          impact: body.recipe === 'diff' ? impactOf(root, groups) : undefined,
          runs: body.recipe === 'release' || body.recipe === 'flaky' ? readRuns(root) : undefined,
          coverage:
            body.recipe === 'release'
              ? await buildCoverage(
                  {
                    store: deps.ctx.store,
                    appDataDir: deps.ctx.location.paths.appData,
                    root,
                  },
                  groups,
                )
              : undefined,
        });

        if (body.save !== true) return { preview };
        const saved = savePlan(
          root,
          toPlan(preview, { environmentId: body.environmentId, title: body.title }),
          new Date().toISOString(),
        );
        return { preview, plan: saved, plans: readPlans(root) };
      });
    },
  );

  /**
   * Тест-поинты плана: что именно предстоит пройти.
   *
   * Считается на лету, а не хранится: библиотека и окружения меняются, и
   * сохранённый список поинтов устарел бы к следующему прогону.
   */
  app.get<{ Querystring: { path?: string; id?: string; environmentId?: string } }>(
    '/api/project-tests/plan/points',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        const id = String(request.query.id ?? '');
        const plan = readPlan(root, id);
        if (!plan)
          throw coded(
            new ProjectTestsNotFoundError(`Плана «${id}» в проекте нет.`),
            'plan-not-found',
            { id },
          );
        const points = buildPoints(planCases(readGroups(root), plan), readEnvironments(root), {
          plan,
          environmentId: request.query.environmentId || undefined,
        });
        return { plan, points };
      });
    },
  );
}

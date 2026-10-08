import type {
  ProjectTestPlan,
  ProjectTestPlanBuildRequest,
  ProjectTestPlanPreview,
  ProjectTestPlanRecipe,
} from '@agentdeck/contracts';
import type { FastifyInstance } from 'fastify';
import {
  ProjectTestsError,
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
} from '../../../domains/project-tests/project-tests.ts';
import { buildCoverage } from '../../../domains/project-tests/coverage-matrix/coverage-matrix.ts';
import { guard, guardAsync, requireRoot, type TestsDeps } from '../shared/shared.ts';
import { coded } from '../../../lib/server-text/server-text.ts';

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
/**
 * Отбор правилом «сейчас» — только чтение: библиотека, прогоны, дифф, покрытие.
 * Каждому правилу нужны свои данные, и читает их маршрут: сам сборщик ничего не
 * знает ни про файлы, ни про git, ни про Jira — потому и проверяется тестом
 * целиком. Записи здесь нет и быть не должно: этим же отбором живёт GET
 * предпросмотра, который зовёт карточка агента.
 */
async function previewFor(
  deps: TestsDeps,
  root: string,
  body: ProjectTestPlanBuildRequest,
): Promise<ProjectTestPlanPreview> {
  const groups = readGroups(root);
  return buildPlanPreview({
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
}

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
        const preview = await previewFor(deps, root, body);
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
   * Тот же отбор правилом — только чтение. Его зовёт карточка агента: сборка
   * карточки не смеет писать (реестр возможностей), а POST выше пишет при
   * `save`. Здесь нет ни параметра сохранения, ни вызова записи: лишний `save`
   * в запросе просто не читается.
   */
  app.get<{
    Querystring: {
      path?: string;
      recipe?: string;
      budget?: string;
      release?: string;
      threshold?: string;
      environmentId?: string;
      title?: string;
    };
  }>('/api/project-tests/plan/preview', async (request, reply) => {
    const root = requireRoot(request.query.path, reply);
    if (!root) return reply;
    const query = request.query;
    // «abc» раньше становилось NaN и молча подменялось умолчанием сборщика —
    // карточка показывала отбор не по тому числу, что просили.
    const number = (field: 'budget' | 'threshold'): number | undefined => {
      const value = query[field];
      if (value === undefined || value === '') return undefined;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
      throw coded(
        new ProjectTestsError(`${field} должен быть числом, а пришло «${value}».`),
        'tests-plan-number-invalid',
        { field, value },
      );
    };
    return guardAsync(reply, async () => ({
      preview: await previewFor(deps, root, {
        recipe: String(query.recipe ?? '') as ProjectTestPlanRecipe,
        budget: number('budget'),
        release: query.release || undefined,
        threshold: number('threshold'),
        environmentId: query.environmentId || undefined,
        title: query.title || undefined,
      }),
    }));
  });

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

import type { ProjectTestPlan } from '@agentdeck/contracts';
import type { FastifyInstance } from 'fastify';
import {
  ProjectTestsNotFoundError,
  buildPoints,
  planCases,
  readEnvironments,
  readGroups,
  readPlan,
  readPlans,
  removePlan,
  savePlan,
} from '../../domains/project-tests.ts';
import { guard, requireRoot } from './shared.ts';

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
export function registerTestPlanRoutes(app: FastifyInstance): void {
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
        return reply.code(400).send({ message: 'Нужно название плана.' });
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
        if (!plan) throw new ProjectTestsNotFoundError(`Плана «${id}» в проекте нет.`);
        const points = buildPoints(planCases(readGroups(root), plan), readEnvironments(root), {
          plan,
          environmentId: request.query.environmentId || undefined,
        });
        return { plan, points };
      });
    },
  );
}

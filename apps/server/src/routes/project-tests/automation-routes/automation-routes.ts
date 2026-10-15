import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type {
  ProjectTestAutomationCommand,
  ProjectTestAutomationInfo,
  ProjectTestTurnHooks,
} from '@agentdeck/contracts';
import {
  adoptUnmatched,
  automationRecipes,
  installTurnHooks,
  readAutomation,
  readTurnHooks,
  removeAutomation,
  removeTurnHooks,
  testsHookScript,
  writeAutomation,
} from '../../../domains/project-tests/project-tests.ts';
import {
  assertNoE2eRun,
  assertOwnProject,
  assertUnlocked,
  buildView,
  guard,
  requireRoot,
  type TestsDeps,
} from '../shared/shared.ts';

/**
 * Своя команда прогона проекта (`automation.json`) из окна раздела: готовые
 * рецепты для бэкенда, запись, снятие — и «Завести кейсы» для тестов прогона
 * без кейса.
 *
 * Команду панель потом исполняет сама, поэтому запись — только у проекта
 * реестра и копий его ветки (403), и не посреди идущего прогона (409): тот уже
 * гонит прежнюю строку, а итог подписал бы новой.
 */
export function registerTestAutomationRoutes(app: FastifyInstance, deps: TestsDeps): void {
  app.get<{ Querystring: { path?: string } }>('/api/project-tests/automation', (request, reply) => {
    const root = requireRoot(request.query.path, reply);
    if (!root) return reply;
    return guard(reply, (): ProjectTestAutomationInfo => {
      const { automation, error, messageCode } = readAutomation(root);
      return {
        ...(automation ? { automation } : {}),
        ...(error ? { error } : {}),
        ...(messageCode ? { messageCode } : {}),
        recipes: automationRecipes(root),
      };
    });
  });

  app.put<{ Body: Partial<ProjectTestAutomationCommand> & { path?: string } }>(
    '/api/project-tests/automation',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        assertOwnProject(deps, root);
        assertNoE2eRun(deps, root);
        const body = request.body ?? {};
        writeAutomation(root, {
          command: typeof body.command === 'string' ? body.command : '',
          ...(typeof body.report === 'string' && body.report.trim() ? { report: body.report } : {}),
          ...(typeof body.timeoutMinutes === 'number'
            ? { timeoutMinutes: body.timeoutMinutes }
            : {}),
          ...(typeof body.format === 'string' ? { format: body.format } : {}),
        });
        return buildView(root, deps);
      });
    },
  );

  app.delete<{ Querystring: { path?: string } }>(
    '/api/project-tests/automation',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        assertOwnProject(deps, root);
        assertNoE2eRun(deps, root);
        removeAutomation(root);
        return buildView(root, deps);
      });
    },
  );

  /**
   * Тестам последнего прогона без кейса — кейсы с привязкой. Сервер помнит их
   * до следующего прогона; нечего заводить — пустой итог, а не ошибка: кнопку
   * мог нажать второй открытый экран.
   */
  // Проверка конца хода агента — хуки проекта (`turn-hooks`): видна и переключается здесь.
  app.get<{ Querystring: { path?: string } }>('/api/project-tests/turn-hooks', (request, reply) => {
    const root = requireRoot(request.query.path, reply);
    if (!root) return reply;
    return guard(reply, (): ProjectTestTurnHooks => ({
      state: readTurnHooks(deps.ctx.location.paths.appData, root),
    }));
  });

  app.put<{ Body: { path?: string; enabled?: boolean } }>(
    '/api/project-tests/turn-hooks',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      return guard(reply, (): ProjectTestTurnHooks => {
        assertOwnProject(deps, root);
        const appData = deps.ctx.location.paths.appData;
        return {
          state:
            request.body?.enabled === false
              ? removeTurnHooks(appData, root)
              : installTurnHooks(appData, root, testsHookScript(), true),
        };
      });
    },
  );

  app.post<{ Body: { path?: string } }>('/api/project-tests/e2e/adopt', (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    return guard(reply, () => {
      assertOwnProject(deps, root);
      assertUnlocked(deps, root);
      assertNoE2eRun(deps, root);
      const results = deps.e2eRuns?.takeUnmatched(root) ?? [];
      const bases = automationRecipes(root).map((recipe) => join(root, recipe.dir));
      try {
        const adopt = adoptUnmatched(root, results, bases, new Date().toISOString());
        deps.e2eRuns?.markAdopted(root, adopt.added);
        return { adopt, view: buildView(root, deps) };
      } catch (error) {
        deps.e2eRuns?.restoreUnmatched(root, results);
        throw error;
      }
    });
  });
}

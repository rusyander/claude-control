import type { FastifyInstance } from 'fastify';
import {
  ProjectTestsLockedError,
  buildPyramid,
  chooseE2eFolder,
  createE2eFolder,
  e2eFolderView,
  removeE2eFolder,
  runSecrets,
  syncE2eFolder,
} from '../../domains/project-tests.ts';
import { coded } from '../../lib/server-text.ts';
import {
  assertNoE2eRun,
  assertOwnProject,
  assertUnlocked,
  buildView,
  guard,
  requireRoot,
  type TestsDeps,
} from './shared.ts';

/**
 * Папка e2e проекта: увидеть, завести, убрать и сверить с кейсами.
 *
 * Сверка пишет в файлы групп, поэтому уважает замок прогона: агент, который
 * сейчас переписывает группу, и сверка поверх него потеряли бы чью-то правку.
 * Заведение кейсов не трогает — ему замок не нужен; удаление замок уважает:
 * агент и раннер работают со спеками папки.
 *
 * Все ответы, что меняют состояние, возвращают полный вид раздела: карточка
 * папки и список групп обновляются одним ответом, без второго запроса.
 */
export function registerTestE2eRoutes(app: FastifyInstance, deps: TestsDeps): void {
  const appData = deps.ctx.location.paths.appData;

  app.get<{ Querystring: { path?: string } }>('/api/project-tests/e2e', (request, reply) => {
    const root = requireRoot(request.query.path, reply);
    if (!root) return reply;
    return guard(reply, () => e2eFolderView(root, appData));
  });

  /**
   * Пирамида: модульные и интеграционные рядом с e2e. Отдельным запросом, а не
   * полем вида: обход всего проекта не для опроса раз в несколько секунд.
   */
  app.get<{ Querystring: { path?: string } }>('/api/project-tests/pyramid', (request, reply) => {
    const root = requireRoot(request.query.path, reply);
    if (!root) return reply;
    return guard(reply, () => buildPyramid(root, { appData }));
  });

  /**
   * Завести папку: есть своя — вернуть её как есть, ничего не создавая. Только у
   * проекта реестра и копий его ветки — запись в чужое дерево (403).
   */
  app.post<{ Body: { path?: string } }>('/api/project-tests/e2e', (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    return guard(reply, () => {
      assertOwnProject(deps, root);
      createE2eFolder(appData, root, new Date().toISOString());
      // Новая папка наблюдается сразу, а не через минуту переспроса.
      deps.e2eWatch?.refresh(root);
      return buildView(root, deps);
    });
  });

  /**
   * Убрать заведённую панелью папку; чужие файлы в ней — 409 без `force=1`.
   * Пока агент раздела пишет спеки или идут автотесты — 409 и с `force`:
   * «вместе с ними» стёр бы работу, которая идёт прямо сейчас.
   */
  app.delete<{ Querystring: { path?: string; force?: string } }>(
    '/api/project-tests/e2e',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        assertUnlocked(deps, root);
        assertNoE2eRun(deps, root);
        removeE2eFolder(appData, root, request.query.force === '1');
        deps.e2eWatch?.refresh(root);
        return buildView(root, deps);
      });
    },
  );

  /**
   * Сверить тесты папки с кейсами: новые — в кейсы, знакомым — привязку.
   * `dir` — человек выбрал папку сам (монорепозиторий, `candidates` вида): выбор
   * запоминается, и дальше сверка, прогон и слежение идут по ней.
   */
  app.post<{ Body: { path?: string; dir?: string } }>(
    '/api/project-tests/e2e/sync',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        assertUnlocked(deps, root);
        const dir = request.body?.dir?.trim();
        if (dir) {
          chooseE2eFolder(appData, root, dir);
          deps.e2eWatch?.refresh(root);
        }
        const sync = syncE2eFolder(root, new Date().toISOString(), { appData });
        return { sync, view: buildView(root, deps) };
      });
    },
  );

  /** Выбор прогона: группа и/или кейсы; мусор в теле — как будто выбора нет. */
  const runSelection = (
    groupId: unknown,
    caseIds: unknown,
  ): { groupId?: string; caseIds?: string[] } => {
    const ids = Array.isArray(caseIds)
      ? caseIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 1000)
      : [];
    return {
      ...(typeof groupId === 'string' && groupId ? { groupId } : {}),
      ...(ids.length > 0 ? { caseIds: ids } : {}),
    };
  };

  /**
   * «Прогнать автотесты»: команда каркаса папки (или своя команда проекта из
   * `automation.json`), без агента и без токенов. `groupId`/`caseIds` сужают
   * прогон до файлов этих кейсов; у выбранных нет автотеста — 400.
   * Отвечает сразу (команда идёт в фоне), итог — полем `e2eRun` вида раздела.
   * Пока агент раздела пишет в группы, результаты лечь не могут — 409. Каталог не
   * из реестра и не копия его ветки — 403: команда здесь исполняется.
   */
  app.post<{
    Body: { path?: string; environmentId?: string; groupId?: unknown; caseIds?: unknown };
  }>('/api/project-tests/e2e/run', (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    return guard(reply, () => {
      assertOwnProject(deps, root);
      const runId = deps.runs.holds(root);
      if (runId) {
        throw coded(
          new ProjectTestsLockedError(
            `Идёт прогон (${runId}) — он пишет в те же файлы. Дождись конца или останови его.`,
            runId,
          ),
          'group-run-in-progress',
          { runId },
        );
      }
      deps.e2eRuns?.start({
        root,
        appData,
        environmentId: request.body?.environmentId || undefined,
        ...runSelection(request.body?.groupId, request.body?.caseIds),
        secrets: (environment) => runSecrets(appData, root, environment),
      });
      return buildView(root, deps);
    });
  });

  /** Остановить прогон автотестов: итог — то, что успело лечь в отчёт. */
  app.post<{ Body: { path?: string } }>('/api/project-tests/e2e/run/stop', (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    return guard(reply, () => {
      deps.e2eRuns?.stop(root);
      return buildView(root, deps);
    });
  });
}

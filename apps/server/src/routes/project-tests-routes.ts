import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type {
  ProjectTestCaseInput,
  ProjectTestRunMode,
  ProjectTestsView,
} from '@claude-control/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../context.ts';
import { checkProjectDir } from '../domains/projects.ts';
import { projectBackupName } from '../lib/safe-io.ts';
import {
  DEFAULT_GROUPS,
  ProjectTestRunRegistry,
  ProjectTestsError,
  ProjectTestsNotFoundError,
  TESTS_DIR,
  createGroup,
  hasConvention,
  installConvention,
  readGroups,
  removeCase,
  removeGroup,
  upsertCase,
} from '../domains/project-tests.ts';

/**
 * Тест-кейсы проекта: список, правка и прогоны агента по ним.
 *
 * Каталог приходит путём, как у файлов и git проекта: вкладку открывают на
 * любой папке, и в реестре проектов её может не быть вовсе.
 *
 * Прогресс не отдаётся отдельным потоком: статусы пишет сам агент прямо в файлы
 * кейсов, а клиент поллит этот же маршрут, пока прогон идёт. Так галочки капают
 * по ходу и переживают перезагрузку страницы — состояние лежит на диске, а не в
 * памяти вкладки.
 */
export function registerProjectTestsRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  registry: ProjectTestRunRegistry,
): void {
  const requireRoot = (path: unknown, reply: FastifyReply): string | undefined => {
    const problem = checkProjectDir(String(path ?? ''));
    if (problem) {
      void reply.code(400).send({ message: problem });
      return undefined;
    }
    return resolve(String(path));
  };

  /** Ошибка домена — это 400 (404 для отсутствующей группы) с человеческим текстом, а не падение маршрута. */
  const guard = <T>(reply: FastifyReply, action: () => T): T | FastifyReply => {
    try {
      return action();
    } catch (error) {
      if (error instanceof ProjectTestsError) {
        const status = error instanceof ProjectTestsNotFoundError ? 404 : 400;
        return reply.code(status).send({ message: error.message });
      }
      throw error;
    }
  };

  const view = (root: string): ProjectTestsView => ({
    projectPath: root,
    dir: TESTS_DIR,
    groups: readGroups(root),
    run: registry.get(root),
    hasConvention: hasConvention(root),
  });

  /** Список групп с кейсами и состояние прогона. Клиент поллит его при прогоне. */
  app.get<{ Querystring: { path?: string } }>('/api/project-tests', (request, reply) => {
    const root = requireRoot(request.query.path, reply);
    if (!root) return reply;
    return view(root);
  });

  /** Группы, которые панель предлагает завести в пустом проекте. */
  app.get('/api/project-tests/defaults', () => ({ groups: DEFAULT_GROUPS }));

  /** Завести вкладку-группу. Существующая возвращается как есть. */
  app.post<{ Body: { path?: string; id?: string; title?: string; description?: string } }>(
    '/api/project-tests/group',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        createGroup(
          root,
          String(request.body?.id ?? ''),
          request.body?.title,
          request.body?.description,
        );
        return view(root);
      });
    },
  );

  /** Удалить группу вместе с файлом кейсов. */
  app.delete<{ Querystring: { path?: string; id?: string } }>(
    '/api/project-tests/group',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        removeGroup(root, String(request.query.id ?? ''));
        return view(root);
      });
    },
  );

  /** Создать или обновить кейс. Без `id` в теле — создаётся новый. */
  app.post<{ Body: { path?: string; groupId?: string; testCase?: ProjectTestCaseInput } }>(
    '/api/project-tests/case',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      const input = request.body?.testCase;
      if (!input || typeof input !== 'object') {
        return reply.code(400).send({ message: 'Нужно описание теста.' });
      }
      return guard(reply, () => {
        upsertCase(root, String(request.body?.groupId ?? ''), input, new Date().toISOString());
        return view(root);
      });
    },
  );

  /** Удалить кейс. */
  app.delete<{ Querystring: { path?: string; groupId?: string; caseId?: string } }>(
    '/api/project-tests/case',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        removeCase(root, String(request.query.groupId ?? ''), String(request.query.caseId ?? ''));
        return view(root);
      });
    },
  );

  /**
   * Запустить агента: `generate` — написать кейсы, `run` — пройти их.
   * Ответ уходит сразу, дальше клиент следит за прогоном обычным списком.
   */
  app.post<{
    Body: {
      path?: string;
      mode?: ProjectTestRunMode;
      groupId?: string;
      caseIds?: string[];
      scope?: string;
      full?: boolean;
    };
  }>('/api/project-tests/run', (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    const mode = request.body?.mode === 'generate' ? 'generate' : 'run';
    const caseIds = Array.isArray(request.body?.caseIds)
      ? request.body.caseIds.map((id) => String(id)).filter(Boolean)
      : undefined;

    return guard(reply, () => {
      registry.start(
        {
          projectPath: root,
          mode,
          groupId: request.body?.groupId || undefined,
          caseIds: caseIds?.length ? caseIds : undefined,
          scope: request.body?.scope?.trim() || undefined,
          full: request.body?.full === true,
        },
        new Date().toISOString(),
      );
      return view(root);
    });
  });

  /**
   * Вписать соглашение о кейсах в `CLAUDE.md` проекта — после этого кейсы
   * ведёт и обычный разговор, а не только прогоны из этого окна.
   */
  app.post<{ Body: { path?: string } }>('/api/project-tests/convention', (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    // Копия под именем ПРОЕКТНОГО файла, как у вкладки «Правила»; окно тестов
    // работает по пути, поэтому id берём из реестра, а незарегистрированный
    // каталог получает устойчивый ключ из своего пути.
    const claudeMd = resolve(root, 'CLAUDE.md');
    const projectId =
      ctx.store.getProjectByPath(root)?.id ??
      createHash('sha1').update(claudeMd).digest('hex').slice(0, 12);
    installConvention(root, ctx.backupDir, projectBackupName(projectId, claudeMd));
    return view(root);
  });

  /** Остановить прогон. Уже записанные статусы остаются на диске. */
  app.post<{ Body: { path?: string } }>('/api/project-tests/stop', (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    registry.stop(root);
    return view(root);
  });
}

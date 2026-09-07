import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type {
  ProjectTestBulkInput,
  ProjectTestCaseInput,
  ProjectTestEnvironment,
  ProjectTestSchema,
  ProjectTestSharedStep,
  ProjectTestView,
} from '@agentdeck/contracts';
import type { FastifyInstance } from 'fastify';
import { projectBackupName } from '../../lib/safe-io.ts';
import { sendConditional } from '../../lib/conditional-get.ts';
import {
  DEFAULT_GROUPS,
  bulkCases,
  createGroup,
  installConvention,
  removeCase,
  removeEnvironment,
  removeGroup,
  removeSharedStep,
  removeView,
  saveEnvironment,
  saveSchema,
  saveSharedStep,
  saveView,
  updateGroup,
  upsertCase,
} from '../../domains/project-tests.ts';
import { assertUnlocked, buildView, guard, idList, requireRoot, type TestsDeps } from './shared.ts';

/**
 * Библиотека: группы, кейсы, общие шаги, окружения, свои поля и статусы,
 * сохранённые фильтры.
 *
 * Каждый ответ — полный вид раздела: правка кейса может задеть вид, план и
 * счётчики, и собирать это клиенту по кускам не из чего.
 *
 * Прогресс прогона не отдаётся отдельным потоком: статусы пишет сам агент прямо
 * в файлы кейсов, а клиент поллит `GET /api/project-tests`, пока прогон идёт.
 * Так галочки капают по ходу и переживают перезагрузку страницы — состояние
 * лежит на диске, а не в памяти вкладки.
 */
export function registerTestLibraryRoutes(app: FastifyInstance, deps: TestsDeps): void {
  const now = (): string => new Date().toISOString();

  /**
   * Список групп с кейсами и состояние прогона. Клиент поллит его при прогоне —
   * поэтому ответ условный: пока агент думает над очередным кейсом, ничего не
   * меняется, и повторный запрос стоит 304 вместо десятков килобайт кейсов.
   */
  app.get<{ Querystring: { path?: string } }>('/api/project-tests', (request, reply) => {
    const root = requireRoot(request.query.path, reply);
    if (!root) return reply;
    return guard(reply, () => sendConditional(request, reply, buildView(root, deps)));
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
        return buildView(root, deps);
      });
    },
  );

  /** Переименовать группу. Идентификатор не меняется — это имя файла. */
  app.post<{ Body: { path?: string; id?: string; title?: string; description?: string } }>(
    '/api/project-tests/group/update',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        const id = String(request.body?.id ?? '');
        assertUnlocked(deps, root, id);
        updateGroup(root, id, request.body?.title, request.body?.description);
        return buildView(root, deps);
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
        const id = String(request.query.id ?? '');
        assertUnlocked(deps, root, id);
        removeGroup(root, id);
        return buildView(root, deps);
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
        const groupId = String(request.body?.groupId ?? '');
        assertUnlocked(deps, root, groupId);
        upsertCase(root, groupId, input, now());
        return buildView(root, deps);
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
        const groupId = String(request.query.groupId ?? '');
        assertUnlocked(deps, root, groupId);
        removeCase(root, groupId, String(request.query.caseId ?? ''));
        return buildView(root, deps);
      });
    },
  );

  /**
   * Пакетная правка отмеченных кейсов: тег, приоритет, перенос, архив.
   *
   * Без неё раскладка сотни кейсов по секциям — сотня отдельных сохранений, и
   * каждое переписывает файл группы целиком.
   */
  app.post<{ Body: { path?: string } & Partial<ProjectTestBulkInput> }>(
    '/api/project-tests/bulk',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      const caseIds = idList(request.body?.caseIds);
      if (!caseIds) return reply.code(400).send({ message: 'Не отмечено ни одного кейса.' });
      const action = request.body?.action;
      if (!action) return reply.code(400).send({ message: 'Не указано, что сделать.' });

      return guard(reply, () => {
        const groupId = String(request.body?.groupId ?? '');
        assertUnlocked(deps, root, groupId);
        // Перенос трогает и группу-приёмник: её тоже мог занять прогон.
        if (action === 'move') assertUnlocked(deps, root, request.body?.value?.trim());
        const touched = bulkCases(
          root,
          { groupId, caseIds, action, value: request.body?.value },
          now(),
        );
        return { touched, view: buildView(root, deps) };
      });
    },
  );

  /** Общий шаг: сохранить (без `id` — создаётся). */
  app.post<{ Body: { path?: string; step?: Partial<ProjectTestSharedStep> } }>(
    '/api/project-tests/shared-step',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      const step = request.body?.step;
      if (!step || typeof step !== 'object' || !step.title) {
        return reply.code(400).send({ message: 'Нужно описание общего шага.' });
      }
      return guard(reply, () => {
        saveSharedStep(root, { ...step, title: step.title ?? '' }, now());
        return buildView(root, deps);
      });
    },
  );

  /** Удалить общий шаг. Ссылки на него в кейсах домен проверяет сам. */
  app.delete<{ Querystring: { path?: string; id?: string } }>(
    '/api/project-tests/shared-step',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        removeSharedStep(root, String(request.query.id ?? ''));
        return buildView(root, deps);
      });
    },
  );

  /** Окружение прогона: адрес, браузер, система, команда запуска. */
  app.post<{ Body: { path?: string; environment?: Partial<ProjectTestEnvironment> } }>(
    '/api/project-tests/environment',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      const environment = request.body?.environment;
      if (!environment || typeof environment !== 'object' || !environment.title) {
        return reply.code(400).send({ message: 'Нужно описание окружения.' });
      }
      return guard(reply, () => {
        saveEnvironment(root, { ...environment, title: environment.title ?? '' });
        return buildView(root, deps);
      });
    },
  );

  /** Удалить окружение. */
  app.delete<{ Querystring: { path?: string; id?: string } }>(
    '/api/project-tests/environment',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        removeEnvironment(root, String(request.query.id ?? ''));
        return buildView(root, deps);
      });
    },
  );

  /** Свои поля и свои статусы проекта — целиком, одним файлом. */
  app.post<{ Body: { path?: string; schema?: ProjectTestSchema } }>(
    '/api/project-tests/schema',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      const schema = request.body?.schema;
      if (!schema || typeof schema !== 'object') {
        return reply.code(400).send({ message: 'Нужна схема полей и статусов.' });
      }
      return guard(reply, () => {
        saveSchema(root, schema);
        return buildView(root, deps);
      });
    },
  );

  /** Сохранённый фильтр — он же динамический набор кейсов. */
  app.post<{ Body: { path?: string; view?: Partial<ProjectTestView> } }>(
    '/api/project-tests/view',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      const saved = request.body?.view;
      if (!saved || typeof saved !== 'object' || !saved.title) {
        return reply.code(400).send({ message: 'Нужно описание вида.' });
      }
      return guard(reply, () => {
        saveView(root, { ...saved, title: saved.title ?? '' }, now());
        return buildView(root, deps);
      });
    },
  );

  /** Удалить сохранённый фильтр. */
  app.delete<{ Querystring: { path?: string; id?: string } }>(
    '/api/project-tests/view',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        removeView(root, String(request.query.id ?? ''));
        return buildView(root, deps);
      });
    },
  );

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
      deps.ctx.store.getProjectByPath(root)?.id ??
      createHash('sha1').update(claudeMd).digest('hex').slice(0, 12);
    installConvention(root, deps.ctx.backupDir, projectBackupName(projectId, claudeMd));
    return buildView(root, deps);
  });
}

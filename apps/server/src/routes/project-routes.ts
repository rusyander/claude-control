import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  McpServerDraft,
  PermissionDraft,
  Project,
  ProjectDraft,
  SettingsSource,
} from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { projectBackupName, readTextFile, writeTextFile } from '../lib/safe-io.ts';
import { isLocalId, stripLocalPrefix } from '../lib/settings-source.ts';
import {
  readMcpServers,
  saveMcpServer,
  deleteMcpServer,
  setMcpServerEnabled,
  McpServerExistsError,
} from '../domains/mcp.ts';
import {
  readPermissions,
  savePermission,
  deletePermission,
  hasPermission,
  assertPermissionDraft,
  PermissionExistsError,
  PermissionNotFoundError,
} from '../domains/permissions.ts';
import {
  checkProjectDraft,
  makeProject,
  resolveProjectPaths,
  type ProjectPaths,
} from '../domains/projects.ts';
import { requireProject as requireProjectAccess, type ErrorReply } from './project-access.ts';
import { done } from './write-result.ts';

/**
 * Маршруты проектного уровня конфигурации.
 *
 * Реестр проектов (CRUD `/api/projects`) — это список запомненных путей в
 * состоянии панели. На выбранный проект работают вложенные маршруты, которые
 * читают и пишут ЕГО файлы (`CLAUDE.md`, `.claude/settings.json`, `.mcp.json`)
 * теми же доменными функциями, что и пользовательский уровень, только с
 * проектными путями и с резервной копией перед записью.
 *
 * Проектная область — «сырое» чтение/правка файлов проекта: групповые и
 * disabled-оверлеи пользовательского уровня к ней не применяются. Доменные
 * функции требуют `store` — передаём его, но `groupIds` там неактуальны
 * (проектные сущности в пользовательские группы не входят по смыслу).
 */
export function registerProjectRoutes(app: FastifyInstance, ctx: ServerContext): void {
  /**
   * Запись реестра по id или ответ 404/400 — общий с `project-local-routes.ts`
   * помощник (`project-access.ts`): гейт провайдера и поиск в реестре одни на
   * все проектные маршруты Claude.
   */
  const requireProject = (id: string, reply: ErrorReply): Project | undefined =>
    requireProjectAccess(ctx, id, reply);

  /** Пути к конфигам проекта по id из реестра. */
  const pathsOf = (project: Project): ProjectPaths => resolveProjectPaths(project.path);

  /**
   * Имя резервной копии проектного файла — `project-<id>-<basename>`. Без него
   * копия `<проект>/CLAUDE.md` ложилась под именем пользовательской и попадала в
   * её ленту истории, ротацию и кнопку «Восстановить» (см. `projectBackupName`).
   */
  const backupNameOf = (project: Project, filePath: string): string =>
    projectBackupName(project.id, filePath);

  /**
   * В какой файл настроек проекта писать запись с этим id: локальные записи
   * (`local:`) уходят обратно в `settings.local.json`, остальные — в основной
   * `settings.json`. Так же, как на пользовательском уровне (см. entity-routes).
   */
  const targetSettings = (
    paths: ProjectPaths,
    id: string,
  ): { path: string; source: SettingsSource } =>
    isLocalId(id)
      ? { path: paths.settingsLocal, source: 'settings-local' }
      : { path: paths.settings, source: 'settings' };

  // --- Реестр проектов ---

  app.get('/api/projects', () => ctx.store.getProjects());

  app.post<{ Body: ProjectDraft }>('/api/projects', (request, reply) => {
    const problem = checkProjectDraft(request.body);
    if (problem) {
      return reply.code(400).send({ error: 'invalid_project', message: problem });
    }
    const draft = request.body;
    // Повтор того же каталога — не «создано»: раньше ответ 200 возвращал старую
    // запись и молча переименовывал её, а панель показывала тост о создании.
    const existing = ctx.store.getProjectByPath(draft.path);
    if (existing) {
      return reply.code(409).send({
        error: 'project_exists',
        message: `Этот каталог уже добавлен как «${existing.name}».`,
        project: existing,
      });
    }

    return ctx.store.addProject(makeProject(draft));
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', (request, reply) => {
    if (!ctx.store.getProject(request.params.id)) {
      return reply
        .code(404)
        .send({ error: 'not_found', message: 'Проекта с таким id нет в реестре.' });
    }
    ctx.store.removeProject(request.params.id);
    return { ok: true };
  });

  // --- Правила проекта: CLAUDE.md целиком (сырой markdown) ---

  app.get<{ Params: { id: string } }>('/api/projects/:id/rules', (request, reply) => {
    const project = requireProject(request.params.id, reply);
    if (!project) return reply;
    return { content: readTextFile(pathsOf(project).claudeMd) };
  });

  app.put<{ Params: { id: string }; Body: { content?: unknown } }>(
    '/api/projects/:id/rules',
    (request, reply) => {
      const project = requireProject(request.params.id, reply);
      if (!project) return reply;

      const content = (request.body ?? {}).content;
      // Как и глобальный CLAUDE.md: пустая строка — осознанная очистка, всё
      // нестроковое — отказ, чтобы запрос без поля не затирал файл пустотой.
      if (typeof content !== 'string') {
        return reply.code(400).send({
          error: 'invalid_content',
          message: 'Поле content обязано быть строкой (пустая строка допустима).',
        });
      }

      const claudeMd = pathsOf(project).claudeMd;
      return done(
        writeTextFile(claudeMd, content, {
          backupDir: ctx.backupDir,
          backupName: backupNameOf(project, claudeMd),
        }),
      );
    },
  );

  // --- MCP-серверы проекта: .mcp.json в корне ---

  app.get<{ Params: { id: string } }>('/api/projects/:id/mcp', (request, reply) => {
    const project = requireProject(request.params.id, reply);
    if (!project) return reply;
    return readMcpServers(pathsOf(project).mcpConfig, ctx.store);
  });

  // Занятое имя — 409 вместо записи поверх (та же защита, что и на
  // пользовательском уровне): .mcp.json проекта лежит в его репозитории, и
  // молчаливая замена чужой записи уехала бы в общий коммит.
  const mcpExists = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof McpServerExistsError) {
      return reply.code(409).send({ error: 'server_exists', message: error.message });
    }
    throw error;
  };

  app.post<{ Params: { id: string }; Body: McpServerDraft }>(
    '/api/projects/:id/mcp',
    (request, reply) => {
      const project = requireProject(request.params.id, reply);
      if (!project) return reply;
      const mcpConfig = pathsOf(project).mcpConfig;
      try {
        return done(
          saveMcpServer(mcpConfig, null, request.body, ctx.backupDir, {
            backupName: backupNameOf(project, mcpConfig),
          }),
        );
      } catch (error) {
        return mcpExists(reply, error);
      }
    },
  );

  app.put<{ Params: { id: string; serverId: string }; Body: McpServerDraft }>(
    '/api/projects/:id/mcp/:serverId',
    (request, reply) => {
      const project = requireProject(request.params.id, reply);
      if (!project) return reply;
      const mcpConfig = pathsOf(project).mcpConfig;
      try {
        return done(
          saveMcpServer(mcpConfig, request.params.serverId, request.body, ctx.backupDir, {
            backupName: backupNameOf(project, mcpConfig),
          }),
        );
      } catch (error) {
        return mcpExists(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string; serverId: string } }>(
    '/api/projects/:id/mcp/:serverId',
    (request, reply) => {
      const project = requireProject(request.params.id, reply);
      if (!project) return reply;
      const mcpConfig = pathsOf(project).mcpConfig;
      return done(
        deleteMcpServer(
          mcpConfig,
          request.params.serverId,
          ctx.backupDir,
          backupNameOf(project, mcpConfig),
        ),
      );
    },
  );

  /** Включение/выключение сервера проекта — перенос записи между секциями файла. */
  app.post<{ Params: { id: string; serverId: string }; Body: { isEnabled: boolean } }>(
    '/api/projects/:id/mcp/:serverId/enabled',
    (request, reply) => {
      const project = requireProject(request.params.id, reply);
      if (!project) return reply;
      const mcpConfig = pathsOf(project).mcpConfig;
      return done(
        setMcpServerEnabled(
          mcpConfig,
          request.params.serverId,
          Boolean(request.body?.isEnabled),
          ctx.backupDir,
          backupNameOf(project, mcpConfig),
        ),
      );
    },
  );

  // --- Права проекта: .claude/settings.json (+ settings.local.json) ---

  app.get<{ Params: { id: string } }>('/api/projects/:id/permissions', (request, reply) => {
    const project = requireProject(request.params.id, reply);
    if (!project) return reply;
    const paths = pathsOf(project);
    return readPermissions(paths.settings, ctx.store, paths.settingsLocal);
  });

  app.post<{ Params: { id: string }; Body: PermissionDraft }>(
    '/api/projects/:id/permissions',
    (request, reply) => {
      const project = requireProject(request.params.id, reply);
      if (!project) return reply;
      // Та же проверка, что у пользовательских прав: решение из трёх известных,
      // шаблон не пустой — иначе в settings.json проекта заводился список
      // `undefined` из null-ов.
      const draft = assertPermissionDraft(request.body);
      // Дубль и незнакомый id — как на пользовательском уровне: 409 / 404 без
      // записи. Раньше маршрут писал файл в любом случае: settings.json проекта
      // лежит в его гите и переформатировался ради ничего, а тост говорил «Создано».
      const settings = pathsOf(project).settings;
      if (hasPermission(settings, `${draft.decision}:${draft.pattern}`)) {
        throw new PermissionExistsError(draft.pattern);
      }
      return done(
        savePermission(settings, null, draft, ctx.backupDir, backupNameOf(project, settings)),
      );
    },
  );

  app.put<{ Params: { id: string; permId: string }; Body: PermissionDraft }>(
    '/api/projects/:id/permissions/:permId',
    (request, reply) => {
      const project = requireProject(request.params.id, reply);
      if (!project) return reply;
      const target = targetSettings(pathsOf(project), request.params.permId);
      const draft = assertPermissionDraft(request.body);
      const bareId = stripLocalPrefix(request.params.permId);
      if (!hasPermission(target.path, bareId)) {
        throw new PermissionNotFoundError(request.params.permId);
      }
      return done(
        savePermission(
          target.path,
          bareId,
          draft,
          ctx.backupDir,
          backupNameOf(project, target.path),
        ),
      );
    },
  );

  app.delete<{ Params: { id: string; permId: string } }>(
    '/api/projects/:id/permissions/:permId',
    (request, reply) => {
      const project = requireProject(request.params.id, reply);
      if (!project) return reply;
      const target = targetSettings(pathsOf(project), request.params.permId);
      const bareId = stripLocalPrefix(request.params.permId);
      if (!hasPermission(target.path, bareId)) {
        throw new PermissionNotFoundError(request.params.permId);
      }
      return done(
        deletePermission(target.path, bareId, ctx.backupDir, backupNameOf(project, target.path)),
      );
    },
  );
}

import type { FastifyInstance } from 'fastify';
import type {
  McpServerDraft,
  PermissionDraft,
  Project,
  ProjectDraft,
  SettingsSource,
} from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { readTextFile, writeTextFile } from '../lib/safe-io.ts';
import { isLocalId, stripLocalPrefix } from '../lib/settings-source.ts';
import {
  readMcpServers,
  saveMcpServer,
  deleteMcpServer,
  setMcpServerEnabled,
} from '../domains/mcp.ts';
import { readPermissions, savePermission, deletePermission } from '../domains/permissions.ts';
import {
  checkProjectDir,
  makeProject,
  resolveProjectPaths,
  type ProjectPaths,
} from '../domains/projects.ts';
import { getActiveProvider } from '../providers/registry.ts';

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
  const done = (backupPath?: string): { ok: true; backupPath?: string; needsRestart: true } => ({
    ok: true,
    backupPath,
    needsRestart: true,
  });

  /**
   * Запись реестра по id или 404-ответ. Возвращает undefined, отправив ответ.
   *
   * Дополнительно fail-closed по провайдеру (COMMON-2): эти маршруты пишут файлы
   * ПРОЕКТНОГО УРОВНЯ CLAUDE (CLAUDE.md, .claude/settings.json, .mcp.json).
   * Активен другой провайдер → 400: его проектные файлы обслуживает
   * `/api/projects/:id/provider/*`, а конфиг Claude панель трогать не должна.
   * При активном Claude поведение прежнее (регресс-ноль).
   */
  const requireProject = (
    id: string,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): Project | undefined => {
    if (getActiveProvider(ctx.store).id !== 'claude') {
      reply.code(400).send({
        error: 'section_unsupported',
        message: 'Проектные файлы Claude доступны только при активном провайдере Claude.',
      });
      return undefined;
    }

    const project = ctx.store.getProject(id);
    if (!project) {
      reply.code(404).send({ error: 'not_found', message: 'Проект не найден в реестре' });
      return undefined;
    }
    return project;
  };

  /** Пути к конфигам проекта по id из реестра. */
  const pathsOf = (project: Project): ProjectPaths => resolveProjectPaths(project.path);

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
    const draft = request.body ?? ({} as ProjectDraft);
    const problem = checkProjectDir(String(draft.path ?? ''));
    if (problem) {
      return reply.code(400).send({ error: 'invalid_project', message: problem });
    }

    return ctx.store.addProject(makeProject(draft));
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', (request) => {
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

      return done(writeTextFile(pathsOf(project).claudeMd, content, { backupDir: ctx.backupDir }));
    },
  );

  // --- MCP-серверы проекта: .mcp.json в корне ---

  app.get<{ Params: { id: string } }>('/api/projects/:id/mcp', (request, reply) => {
    const project = requireProject(request.params.id, reply);
    if (!project) return reply;
    return readMcpServers(pathsOf(project).mcpConfig, ctx.store);
  });

  app.post<{ Params: { id: string }; Body: McpServerDraft }>(
    '/api/projects/:id/mcp',
    (request, reply) => {
      const project = requireProject(request.params.id, reply);
      if (!project) return reply;
      return done(saveMcpServer(pathsOf(project).mcpConfig, null, request.body, ctx.backupDir));
    },
  );

  app.put<{ Params: { id: string; serverId: string }; Body: McpServerDraft }>(
    '/api/projects/:id/mcp/:serverId',
    (request, reply) => {
      const project = requireProject(request.params.id, reply);
      if (!project) return reply;
      return done(
        saveMcpServer(
          pathsOf(project).mcpConfig,
          request.params.serverId,
          request.body,
          ctx.backupDir,
        ),
      );
    },
  );

  app.delete<{ Params: { id: string; serverId: string } }>(
    '/api/projects/:id/mcp/:serverId',
    (request, reply) => {
      const project = requireProject(request.params.id, reply);
      if (!project) return reply;
      return done(
        deleteMcpServer(pathsOf(project).mcpConfig, request.params.serverId, ctx.backupDir),
      );
    },
  );

  /** Включение/выключение сервера проекта — перенос записи между секциями файла. */
  app.post<{ Params: { id: string; serverId: string }; Body: { isEnabled: boolean } }>(
    '/api/projects/:id/mcp/:serverId/enabled',
    (request, reply) => {
      const project = requireProject(request.params.id, reply);
      if (!project) return reply;
      return done(
        setMcpServerEnabled(
          pathsOf(project).mcpConfig,
          request.params.serverId,
          Boolean(request.body?.isEnabled),
          ctx.backupDir,
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
      return done(savePermission(pathsOf(project).settings, null, request.body, ctx.backupDir));
    },
  );

  app.put<{ Params: { id: string; permId: string }; Body: PermissionDraft }>(
    '/api/projects/:id/permissions/:permId',
    (request, reply) => {
      const project = requireProject(request.params.id, reply);
      if (!project) return reply;
      const target = targetSettings(pathsOf(project), request.params.permId);
      return done(
        savePermission(
          target.path,
          stripLocalPrefix(request.params.permId),
          request.body,
          ctx.backupDir,
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
      return done(
        deletePermission(target.path, stripLocalPrefix(request.params.permId), ctx.backupDir),
      );
    },
  );
}

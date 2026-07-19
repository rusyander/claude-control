import type { FastifyInstance } from 'fastify';
import type {
  EntityKind,
  EnvVar,
  HookDraft,
  McpServerDraft,
  PermissionDraft,
  RuleDraft,
  SettingsSource,
  SkillDraft,
} from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { readRules, saveRule, deleteRule } from '../domains/rules.ts';
import { readHooks, upsertHook, deleteHook } from '../domains/hooks.ts';
import { readSkills, saveSkill, deleteSkill } from '../domains/skills.ts';
import { readMcpServers, saveMcpServer, deleteMcpServer, checkMcpHealth } from '../domains/mcp.ts';
import { applyEntityState, rewriteHooks, findHook } from '../domains/entity-toggle.ts';
import { isLocalId, stripLocalPrefix } from '../lib/settings-source.ts';
import { readPermissions, savePermission, deletePermission } from '../domains/permissions.ts';
import { readEnvVars, revealEnvValue, saveEnvVar, deleteEnvVar } from '../domains/env.ts';

/**
 * Маршруты сущностей. Ответ на изменение всегда содержит needsRestart:
 * почти всё, что мы правим, Claude Code перечитывает только при старте, и
 * интерфейс должен честно об этом предупреждать.
 */
export function registerEntityRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const paths = (): ReturnType<() => typeof ctx.location.paths> => ctx.location.paths;
  const done = (backupPath?: string): { ok: true; backupPath?: string; needsRestart: true } => ({
    ok: true,
    backupPath,
    needsRestart: true,
  });

  /**
   * В какой файл писать запись с этим идентификатором.
   *
   * Правка локальной записи возвращается в `settings.local.json`, а не
   * переезжает в общий конфиг: личная настройка иначе стала бы общей. Префикс
   * `local:` живёт только в панели — файлу он неизвестен, поэтому снимается.
   */
  const targetOf = (id: string): { path: string; source: SettingsSource } =>
    isLocalId(id)
      ? { path: paths().settingsLocal, source: 'settings-local' }
      : { path: paths().settings, source: 'settings' };

  // --- Правила (CLAUDE.md) ---
  app.get('/api/rules', () => readRules(paths().claudeMd, ctx.store));

  app.put<{ Params: { id: string }; Body: RuleDraft }>('/api/rules/:id', (request) =>
    done(saveRule(paths().claudeMd, request.params.id, request.body, ctx.store, ctx.backupDir)),
  );

  app.post<{ Body: RuleDraft }>('/api/rules', (request) =>
    done(saveRule(paths().claudeMd, '', request.body, ctx.store, ctx.backupDir)),
  );

  app.delete<{ Params: { id: string } }>('/api/rules/:id', (request) =>
    done(deleteRule(paths().claudeMd, request.params.id, ctx.store, ctx.backupDir)),
  );

  // --- Хуки (settings.json + settings.local.json) ---
  app.get('/api/hooks', () => readHooks(paths().settings, ctx.store, paths().settingsLocal));

  app.post<{ Body: HookDraft }>('/api/hooks', (request) =>
    done(upsertHook(paths().settings, paths().hooks, null, request.body, ctx.store, ctx.backupDir)),
  );

  app.put<{ Params: { id: string }; Body: HookDraft }>('/api/hooks/:id', (request) => {
    // Ссылка могла быть сохранена до перехода на контентные id — приводим.
    const id = findHook(ctx, request.params.id)?.id ?? request.params.id;
    const target = targetOf(id);

    return done(
      upsertHook(
        paths().settings,
        paths().hooks,
        stripLocalPrefix(id),
        request.body,
        ctx.store,
        ctx.backupDir,
        target,
      ),
    );
  });

  app.delete<{ Params: { id: string } }>('/api/hooks/:id', (request) => {
    const id = findHook(ctx, request.params.id)?.id ?? request.params.id;

    return done(deleteHook(paths().settings, id, ctx.store, ctx.backupDir, targetOf(id)));
  });

  // --- Скиллы (папки в skills/) ---
  app.get('/api/skills', () => readSkills(paths().skills, ctx.store));

  app.post<{ Body: SkillDraft }>('/api/skills', (request) =>
    done(saveSkill(paths().skills, null, request.body, ctx.backupDir)),
  );

  app.put<{ Params: { id: string }; Body: SkillDraft }>('/api/skills/:id', (request) =>
    done(saveSkill(paths().skills, request.params.id, request.body, ctx.backupDir)),
  );

  // Файлы внутри скилла живут на общих ресурсных маршрутах
  // (`/api/resources/skill/:id/file`) — там же, где файлы остальных видов.
  // Отдельного набора для скиллов больше нет: две почти одинаковые реализации
  // расходились, и правка попадала не туда, куда ходит интерфейс.

  app.delete<{ Params: { id: string } }>('/api/skills/:id', (request) =>
    done(deleteSkill(paths().skills, request.params.id, ctx.backupDir)),
  );

  // --- MCP-серверы (~/.claude.json) ---
  app.get('/api/mcp', () => readMcpServers(paths().mcpConfig, ctx.store));

  app.post<{ Body: McpServerDraft }>('/api/mcp', (request) =>
    done(saveMcpServer(paths().mcpConfig, null, request.body, ctx.backupDir)),
  );

  app.put<{ Params: { id: string }; Body: McpServerDraft }>('/api/mcp/:id', (request) =>
    done(saveMcpServer(paths().mcpConfig, request.params.id, request.body, ctx.backupDir)),
  );

  app.delete<{ Params: { id: string } }>('/api/mcp/:id', (request) =>
    done(deleteMcpServer(paths().mcpConfig, request.params.id, ctx.backupDir)),
  );

  /** Проверка живости конкретного сервера — запускает его и говорит по протоколу MCP. */
  app.post<{ Params: { id: string } }>('/api/mcp/:id/health', async (request, reply) => {
    const server = readMcpServers(paths().mcpConfig, ctx.store).find(
      (item) => item.id === request.params.id,
    );
    if (!server) return reply.code(404).send({ error: 'not_found', message: 'Сервер не найден' });

    return checkMcpHealth(server);
  });

  // --- Правила доступа (settings.json + settings.local.json) ---
  app.get('/api/permissions', () =>
    readPermissions(paths().settings, ctx.store, paths().settingsLocal),
  );

  app.post<{ Body: PermissionDraft }>('/api/permissions', (request) =>
    done(savePermission(paths().settings, null, request.body, ctx.backupDir)),
  );

  app.put<{ Params: { id: string }; Body: PermissionDraft }>('/api/permissions/:id', (request) => {
    const { id } = request.params;

    return done(
      savePermission(targetOf(id).path, stripLocalPrefix(id), request.body, ctx.backupDir),
    );
  });

  app.delete<{ Params: { id: string } }>('/api/permissions/:id', (request) => {
    const { id } = request.params;

    return done(deletePermission(targetOf(id).path, stripLocalPrefix(id), ctx.backupDir));
  });

  // --- Переменные окружения ---
  app.get('/api/env', () =>
    readEnvVars(paths().settings, paths().secretsEnv, paths().settingsLocal),
  );

  app.get<{ Querystring: { key: string; source: EnvVar['source'] } }>(
    '/api/env/reveal',
    (request) =>
      revealEnvValue(
        paths().settings,
        paths().secretsEnv,
        request.query.key,
        request.query.source,
        paths().settingsLocal,
      ),
  );

  app.post<{ Body: Parameters<typeof saveEnvVar>[2] }>('/api/env', (request) =>
    done(
      saveEnvVar(
        paths().settings,
        paths().secretsEnv,
        request.body,
        ctx.backupDir,
        paths().settingsLocal,
      ),
    ),
  );

  app.delete<{ Querystring: { key: string; source: EnvVar['source'] } }>(
    '/api/env',
    (request) =>
      done(
        deleteEnvVar(
          paths().settings,
          paths().secretsEnv,
          request.query.key,
          request.query.source,
          ctx.backupDir,
          paths().settingsLocal,
        ),
      ),
  );

  // --- Включение и выключение любой сущности ---
  app.post<{ Params: { kind: EntityKind; id: string }; Body: { isEnabled: boolean } }>(
    '/api/entities/:kind/:id/enabled',
    (request) => {
      const { kind } = request.params;
      const { isEnabled } = request.body;

      // Идентификатор мог прийти в прежнем, позиционном виде — из состава
      // группы или из ссылки, сохранённой до перехода на контентные id.
      // Приводим его к нынешнему, попутно забирая старый: отметку надо снять
      // и с него, иначе она осталась бы висеть навсегда.
      const hook = kind === 'hook' ? findHook(ctx, request.params.id) : undefined;
      const id = hook?.id ?? request.params.id;
      const legacyId = hook?.legacyId;

      // Отметку ставим до применения: разбор файлов опирается на неё, чтобы
      // вернуть сущность уже с новым состоянием.
      ctx.store.setEnabled(kind, id, isEnabled, legacyId);

      // Применяем не то, что попросили, а итог: сущность, погашенную группой,
      // одиночный переключатель включить не может — иначе состояние в панели
      // разошлось бы с состоянием группы.
      const effective = !ctx.store.isDisabled(kind, id, legacyId);
      const { needsHookRewrite } = applyEntityState(ctx, kind, id, effective);

      return done(needsHookRewrite ? rewriteHooks(ctx) : undefined);
    },
  );
}

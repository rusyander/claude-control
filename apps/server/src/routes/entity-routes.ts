import type { FastifyInstance } from 'fastify';
import type {
  EntityKind,
  HookDraft,
  McpServerDraft,
  PermissionDraft,
  RuleDraft,
  SkillDraft,
} from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { readRules, saveRule, deleteRule } from '../domains/rules.ts';
import { readHooks, upsertHook, deleteHook, writeHooks } from '../domains/hooks.ts';
import {
  readSkills,
  saveSkill,
  setSkillEnabled,
  deleteSkill,
  readSkillFile,
  writeSkillFile,
  deleteSkillFile,
  moveSkillFile,
} from '../domains/skills.ts';
import {
  readMcpServers,
  saveMcpServer,
  setMcpServerEnabled,
  deleteMcpServer,
  checkMcpHealth,
} from '../domains/mcp.ts';
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

  // --- Хуки (settings.json) ---
  app.get('/api/hooks', () => readHooks(paths().settings, ctx.store));

  app.post<{ Body: HookDraft }>('/api/hooks', (request) =>
    done(upsertHook(paths().settings, paths().hooks, null, request.body, ctx.store, ctx.backupDir)),
  );

  app.put<{ Params: { id: string }; Body: HookDraft }>('/api/hooks/:id', (request) =>
    done(
      upsertHook(
        paths().settings,
        paths().hooks,
        request.params.id,
        request.body,
        ctx.store,
        ctx.backupDir,
      ),
    ),
  );

  app.delete<{ Params: { id: string } }>('/api/hooks/:id', (request) =>
    done(deleteHook(paths().settings, request.params.id, ctx.store, ctx.backupDir)),
  );

  // --- Скиллы (папки в skills/) ---
  app.get('/api/skills', () => readSkills(paths().skills, ctx.store));

  app.post<{ Body: SkillDraft }>('/api/skills', (request) =>
    done(saveSkill(paths().skills, null, request.body, ctx.backupDir)),
  );

  app.put<{ Params: { id: string }; Body: SkillDraft }>('/api/skills/:id', (request) =>
    done(saveSkill(paths().skills, request.params.id, request.body, ctx.backupDir)),
  );

  // Содержимое вложенного файла скилла: большие скиллы состоят из десятков
  // файлов, и заглянуть в них нужно не выходя из списка.
  app.get<{ Params: { id: string }; Querystring: { file: string } }>(
    '/api/skills/:id/file',
    (request) => ({
      file: request.query.file,
      content: readSkillFile(paths().skills, request.params.id, request.query.file),
    }),
  );

  // Правка одного файла скилла: у больших скиллов десятки файлов, и
  // пересохранять весь скилл ради одной строки незачем.
  app.put<{ Params: { id: string }; Body: { file: string; content: string } }>(
    '/api/skills/:id/file',
    (request) => {
      writeSkillFile(
        paths().skills,
        request.params.id,
        request.body.file,
        request.body.content,
        ctx.backupDir,
      );
      return done();
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { file: string } }>(
    '/api/skills/:id/file',
    (request) => {
      deleteSkillFile(paths().skills, request.params.id, request.query.file);
      return done();
    },
  );

  app.post<{ Params: { id: string }; Body: { from: string; to: string } }>(
    '/api/skills/:id/move',
    (request) => {
      moveSkillFile(paths().skills, request.params.id, request.body.from, request.body.to);
      return done();
    },
  );

  app.delete<{ Params: { id: string } }>('/api/skills/:id', (request) => {
    deleteSkill(paths().skills, request.params.id);
    return done();
  });

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

  // --- Правила доступа (permissions) ---
  app.get('/api/permissions', () => readPermissions(paths().settings, ctx.store));

  app.post<{ Body: PermissionDraft }>('/api/permissions', (request) =>
    done(savePermission(paths().settings, null, request.body, ctx.backupDir)),
  );

  app.put<{ Params: { id: string }; Body: PermissionDraft }>('/api/permissions/:id', (request) =>
    done(savePermission(paths().settings, request.params.id, request.body, ctx.backupDir)),
  );

  app.delete<{ Params: { id: string } }>('/api/permissions/:id', (request) =>
    done(deletePermission(paths().settings, request.params.id, ctx.backupDir)),
  );

  // --- Переменные окружения ---
  app.get('/api/env', () => readEnvVars(paths().settings, paths().secretsEnv));

  app.get<{ Querystring: { key: string; source: 'settings' | 'secrets' } }>(
    '/api/env/reveal',
    (request) =>
      revealEnvValue(paths().settings, paths().secretsEnv, request.query.key, request.query.source),
  );

  app.post<{ Body: Parameters<typeof saveEnvVar>[2] }>('/api/env', (request) =>
    done(saveEnvVar(paths().settings, paths().secretsEnv, request.body, ctx.backupDir)),
  );

  app.delete<{ Querystring: { key: string; source: 'settings' | 'secrets' } }>(
    '/api/env',
    (request) =>
      done(
        deleteEnvVar(
          paths().settings,
          paths().secretsEnv,
          request.query.key,
          request.query.source,
          ctx.backupDir,
        ),
      ),
  );

  // --- Включение и выключение любой сущности ---
  app.post<{ Params: { kind: EntityKind; id: string }; Body: { isEnabled: boolean } }>(
    '/api/entities/:kind/:id/enabled',
    (request) => {
      const { kind, id } = request.params;
      const { isEnabled } = request.body;

      // У скиллов и MCP-серверов выключение физическое: перенос папки или
      // секции конфига. Остальное хранится отметкой в состоянии приложения.
      if (kind === 'skill') setSkillEnabled(paths().skills, id, isEnabled);
      if (kind === 'mcp') setMcpServerEnabled(paths().mcpConfig, id, isEnabled, ctx.backupDir);

      // Отметку ставим до перечитывания: разбор файлов опирается на неё,
      // чтобы вернуть сущность уже с новым состоянием.
      ctx.store.setEnabled(kind, id, isEnabled);

      // Правила и хуки физически перезаписываются в своих файлах: правило
      // уезжает в раздел отключённых, хук исчезает из settings.json.
      if (kind === 'rule') {
        const rule = readRules(paths().claudeMd, ctx.store).find((item) => item.id === id);
        if (rule) saveRule(paths().claudeMd, id, rule, ctx.store, ctx.backupDir);
      }
      if (kind === 'hook') {
        const hooks = readHooks(paths().settings, ctx.store);
        return done(writeHooks(paths().settings, hooks, ctx.backupDir));
      }

      return done();
    },
  );
}

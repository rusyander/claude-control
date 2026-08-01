import type { FastifyInstance, FastifyReply } from 'fastify';
import { SecretBackupUnavailableError } from '../lib/safe-io.ts';
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
import { readHooks, upsertHook, deleteHook, moveHook } from '../domains/hooks.ts';
import { readCommands } from '../domains/commands.ts';
import {
  readSkills,
  saveSkill,
  deleteSkill,
  renameSkill,
  SkillExistsError,
} from '../domains/skills.ts';
import {
  readMcpServers,
  saveMcpServer,
  deleteMcpServer,
  migrateMcpServerIdentity,
  checkMcpHealth,
  listMcpServerTools,
  McpServerExistsError,
} from '../domains/mcp.ts';
import {
  startOAuth,
  finishOAuth,
  clearOAuth,
  hasOAuthTokens,
  oauthProviderFor,
  oauthCallbackPage,
} from '../domains/mcp-oauth.ts';
import { applyEntityState, rewriteHooks, findHook } from '../domains/entity-toggle.ts';
import { isLocalId, stripLocalPrefix } from '../lib/settings-source.ts';
import {
  readPermissions,
  savePermission,
  deletePermission,
  movePermission,
} from '../domains/permissions.ts';
import {
  readEnvVars,
  revealEnvValue,
  saveEnvVar,
  deleteEnvVar,
  moveEnvVar,
} from '../domains/env.ts';
import {
  resolveInstructionsTarget,
  readInstructionsInfo,
  writeInstructions,
} from '../domains/instructions.ts';

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

  app.delete<{ Params: { id: string } }>('/api/rules/:id', (request) => {
    // След в state.json снимаем ДО удаления: `deleteRule` сдвигает id уцелевших
    // тёзок («foo-2» → «foo»), и после него отметки удалённого «foo» уже
    // принадлежали бы выжившему правилу.
    ctx.store.removeEntity('rule', request.params.id);
    return done(deleteRule(paths().claudeMd, request.params.id, ctx.store, ctx.backupDir));
  });

  // --- Глобальные инструкции целиком (универсальны по активному провайдеру) ---
  // Раздел «Правила» разбирает файл на карточки, но там видно не всё: шапка,
  // произвольные секции и форматирование остаются за кадром. Здесь — файл целиком,
  // как его читает сам CLI, с правкой и резервной копией перед записью. Файл
  // берётся у активного провайдера: Claude→CLAUDE.md, Codex→AGENTS.md,
  // Gemini→GEMINI.md. Провайдер без задокументированного файла инструкций
  // (globalInstructions ≠ ready) → 4xx, путь не угадываем (fail-closed).
  const SECTION_UNSUPPORTED = {
    error: 'section_unsupported',
    message: 'У активного провайдера нет раздела глобальных инструкций.',
  } as const;

  app.get('/api/claude-md', (_request, reply) => {
    const target = resolveInstructionsTarget(ctx.store, paths().claudeMd);
    if (!target) return reply.code(400).send(SECTION_UNSUPPORTED);
    return readInstructionsInfo(target);
  });

  app.put<{ Body: { content?: unknown } }>('/api/claude-md', (request, reply) => {
    const target = resolveInstructionsTarget(ctx.store, paths().claudeMd);
    if (!target) return reply.code(400).send(SECTION_UNSUPPORTED);

    const content = (request.body ?? {}).content;
    // Различаем «намеренно пустой файл» ('') и «поля content нет / оно не строка».
    // Раньше писали `content ?? ''`: запрос без поля затирал файл пустотой.
    // Пустая строка — валидна (осознанная очистка), всё нестроковое — отказ.
    if (typeof content !== 'string') {
      return reply.code(400).send({
        error: 'invalid_content',
        message: 'Поле content обязано быть строкой (пустая строка допустима).',
      });
    }

    return done(writeInstructions(target, content, ctx.backupDir));
  });

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
    const hook = findHook(ctx, request.params.id);
    const id = hook?.id ?? request.params.id;

    const backupPath = deleteHook(paths().settings, id, ctx.store, ctx.backupDir, targetOf(id));
    // Удалённый хук не должен остаться призраком в составе групп и в отметках:
    // иначе группа считает участника, которого нет, а новый хук с тем же
    // содержимым (тот же контентный id) молча унаследовал бы его группы.
    // Прежний, позиционный id снимаем тоже — по нему отметки могли лечь раньше.
    ctx.store.removeEntity('hook', id);
    if (hook?.legacyId) ctx.store.removeEntity('hook', hook.legacyId);

    return done(backupPath);
  });

  // Порядок хуков внутри одного события: раньше он равнялся порядку в файле,
  // переставить из панели было нельзя.
  app.post<{ Params: { id: string }; Body: { direction: 'up' | 'down' } }>(
    '/api/hooks/:id/move',
    (request) => {
      const id = findHook(ctx, request.params.id)?.id ?? request.params.id;
      return done(
        moveHook(
          paths().settings,
          ctx.store,
          id,
          request.body.direction === 'up' ? 'up' : 'down',
          ctx.backupDir,
          paths().settingsLocal,
        ),
      );
    },
  );

  // --- Скиллы (папки в skills/) ---
  app.get('/api/skills', () => readSkills(paths().skills, ctx.store));

  /**
   * Слэш-команды активного провайдера — сводный список того, что вызывается
   * через `/`. Только чтение: правится команда там, где живёт (скилл — в разделе
   * скиллов, плагин — в разделе плагинов). Встроенных команд CLI здесь нет:
   * файла у них не существует, их каталог ведёт клиент.
   */
  app.get('/api/commands', () => readCommands(paths(), ctx.store));

  app.post<{ Body: SkillDraft }>('/api/skills', (request, reply) => {
    try {
      return done(saveSkill(paths().skills, null, request.body, ctx.backupDir));
    } catch (error) {
      // Имя занято выключенным скиллом: молча писать поверх — потеря чужого
      // скилла, поэтому отвечаем конфликтом и оставляем решение человеку.
      if (error instanceof SkillExistsError) {
        return reply.code(409).send({ error: 'skill_exists', message: error.message });
      }
      throw error;
    }
  });

  app.put<{ Params: { id: string }; Body: SkillDraft }>('/api/skills/:id', (request) =>
    done(saveSkill(paths().skills, request.params.id, request.body, ctx.backupDir)),
  );

  // Файлы внутри скилла живут на общих ресурсных маршрутах
  // (`/api/resources/skill/:id/file`) — там же, где файлы остальных видов.
  // Отдельного набора для скиллов больше нет: две почти одинаковые реализации
  // расходились, и правка попадала не туда, куда ходит интерфейс.

  app.delete<{ Params: { id: string } }>('/api/skills/:id', (request) => {
    const backupPath = deleteSkill(paths().skills, request.params.id, ctx.backupDir);
    // Тот же след, что и у остальных видов: состав групп и отметки выключения
    // ключуются именем папки, и новый скилл с тем же именем наследовал бы их.
    ctx.store.removeEntity('skill', request.params.id);

    return done(backupPath);
  });

  // Переименование скилла: имя папки — это идентификатор, поэтому меняется папка,
  // а отметки в state.json (выключение, группы) переезжают на новый id. Тело —
  // {newId} (или синоним {newName}). Ошибки domain несут код: занятое/пустое имя
  // → 400, несуществующий скилл → 404.
  app.post<{ Params: { id: string }; Body: { newId?: string; newName?: string } }>(
    '/api/skills/:id/rename',
    (request, reply) => {
      const newId = request.body?.newId ?? request.body?.newName ?? '';

      try {
        return done(
          renameSkill(paths().skills, request.params.id, newId, ctx.store, ctx.backupDir),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: string }).code;
        return reply
          .code(code === 'not_found' ? 404 : 400)
          .send({ error: 'rename_failed', message });
      }
    },
  );

  // --- MCP-серверы (~/.claude.json) ---
  app.get('/api/mcp', () => readMcpServers(paths().mcpConfig, ctx.store, paths().appData));

  // Занятое имя (в том числе выключенным тёзкой) — 409, как у скиллов и у MCP
  // чужих провайдеров: писать поверх значит потерять чужой сервер, а решение —
  // за человеком (переименовать или открыть существующий).
  const mcpExists = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof McpServerExistsError) {
      return reply.code(409).send({ error: 'server_exists', message: error.message });
    }
    throw error;
  };

  app.post<{ Body: McpServerDraft }>('/api/mcp', (request, reply) => {
    try {
      return done(saveMcpServer(paths().mcpConfig, null, request.body, ctx.backupDir));
    } catch (error) {
      return mcpExists(reply, error);
    }
  });

  // Правка сервера. Смена имени — это смена идентификатора, поэтому вместе с
  // записью в конфиге переезжают отметки состояния (группы, выключение) и
  // сохранённый OAuth-вход: иначе сервер выпадает из групп, а токен остаётся в
  // хранилище под мёртвым ключом.
  app.put<{ Params: { id: string }; Body: McpServerDraft }>(
    '/api/mcp/:id',
    async (request, reply) => {
      let backupPath: string | undefined;
      try {
        backupPath = saveMcpServer(
          paths().mcpConfig,
          request.params.id,
          request.body,
          ctx.backupDir,
        );
      } catch (error) {
        // Отказ до записи: перенос отметок и токена не запускаем — иначе
        // состояние переехало бы на имя, которого сервер так и не получил.
        return mcpExists(reply, error);
      }

      await migrateMcpServerIdentity(
        ctx.store,
        paths().appData,
        request.params.id,
        request.body.name,
      );

      return done(backupPath);
    },
  );

  // Удаление уносит и сохранённый вход: карточки с кнопкой «Выйти» больше нет,
  // так что refresh-токен третьей стороны иначе остался бы в хранилище навсегда
  // и достался бы новому серверу, заведённому под тем же именем.
  app.delete<{ Params: { id: string } }>('/api/mcp/:id', async (request) => {
    const backupPath = deleteMcpServer(paths().mcpConfig, request.params.id, ctx.backupDir);
    await clearOAuth(paths().appData, request.params.id);
    // Вместе с записью и токеном уходит и след в state.json: иначе карточка
    // группы показывает участника-призрака, а сервер, заведённый потом под тем
    // же именем, молча получает чужие группы и их гашение.
    ctx.store.removeEntity('mcp', request.params.id);

    return done(backupPath);
  });

  const findMcpServer = (id: string): ReturnType<typeof readMcpServers>[number] | undefined =>
    readMcpServers(paths().mcpConfig, ctx.store, paths().appData).find((item) => item.id === id);

  /** Проверка живости конкретного сервера — запускает его и говорит по протоколу MCP. */
  app.post<{ Params: { id: string } }>('/api/mcp/:id/health', async (request, reply) => {
    const server = findMcpServer(request.params.id);
    if (!server) return reply.code(404).send({ error: 'not_found', message: 'Сервер не найден' });

    // Сервер с сохранёнными токенами проверяем через OAuth-провайдер: SDK
    // подставит токен и обновит его при истечении.
    const authProvider =
      server.transport !== 'stdio' && hasOAuthTokens(paths().appData, server.id)
        ? oauthProviderFor(server, paths().appData)
        : undefined;

    return checkMcpHealth(
      server,
      30_000,
      authProvider,
      ctx.store.getSettings().mcpNetworkTimeoutMs,
    );
  });

  /**
   * Список инструментов сервера — имена и описания для помощника отбора прав.
   * Тот же провайдер OAuth, что и у проверки связи: сервер с сохранёнными
   * токенами опрашивается от его имени.
   */
  app.post<{ Params: { id: string } }>('/api/mcp/:id/tools', async (request, reply) => {
    const server = findMcpServer(request.params.id);
    if (!server) return reply.code(404).send({ error: 'not_found', message: 'Сервер не найден' });

    const authProvider =
      server.transport !== 'stdio' && hasOAuthTokens(paths().appData, server.id)
        ? oauthProviderFor(server, paths().appData)
        : undefined;

    return listMcpServerTools(
      server,
      30_000,
      authProvider,
      ctx.store.getSettings().mcpNetworkTimeoutMs,
    );
  });

  /**
   * Начать интерактивный вход. Ответ либо `authorized` (токены уже есть), либо
   * `redirect` с адресом, который интерфейс откроет в отдельном окне.
   */
  app.post<{ Params: { id: string } }>('/api/mcp/:id/oauth/start', async (request, reply) => {
    const server = findMcpServer(request.params.id);
    if (!server) return reply.code(404).send({ error: 'not_found', message: 'Сервер не найден' });

    try {
      return await startOAuth(server, paths().appData);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ error: 'oauth_failed', message });
    }
  });

  /**
   * Куда сервер авторизации возвращает пользователя после входа. Это переход по
   * адресу в отдельном окне, а не запрос из интерфейса, поэтому ответ — HTML.
   * Маршрут пропущен мимо origin-guard в index.ts: подделать вход нельзя, state
   * сгенерирован нами и по нему же ищется незавершённый вход.
   */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/mcp/oauth/callback',
    async (request, reply) => {
      const { code, state, error } = request.query;

      if (error) return reply.type('text/html').send(oauthCallbackPage(false, error));
      if (!code || !state) {
        return reply.type('text/html').send(oauthCallbackPage(false, 'Не пришёл код авторизации'));
      }

      try {
        await finishOAuth(state, code);
        return reply.type('text/html').send(oauthCallbackPage(true));
      } catch (finishError) {
        const message = finishError instanceof Error ? finishError.message : String(finishError);
        return reply.type('text/html').send(oauthCallbackPage(false, message));
      }
    },
  );

  /** Забыть авторизацию сервера — удалить сохранённые токены. */
  app.delete<{ Params: { id: string } }>('/api/mcp/:id/oauth', async (request) => {
    await clearOAuth(paths().appData, request.params.id);
    return { ok: true };
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

    const backupPath = deletePermission(targetOf(id).path, stripLocalPrefix(id), ctx.backupDir);
    // Отметки и состав групп ключуются id в том виде, в каком он пришёл (с
    // префиксом `local:`, если право из settings.local.json) — снимаем его же.
    ctx.store.removeEntity('permission', id);

    return done(backupPath);
  });

  // Перенос права в противоположный файл: из settings.json в settings.local.json
  // и обратно. Файл-источник определяется префиксом id (см. targetOf/isLocalId).
  app.post<{ Params: { id: string } }>('/api/permissions/:id/move', (request) =>
    done(movePermission(paths().settings, paths().settingsLocal, request.params.id, ctx.backupDir)),
  );

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

  /**
   * Правка секрета без возможной резервной копии — отказ, но ВНЯТНЫЙ: 409 с
   * причиной и подсказкой, а не 500. Причина одна и та же у записи и удаления:
   * шифрование копий включено, а парольной фразы в памяти нет (обычное дело
   * после перезапуска сервера), и писать копию открытым текстом нельзя.
   */
  const withSecretBackupGuard = <T>(reply: FastifyReply, run: () => T): T | FastifyReply => {
    try {
      return run();
    } catch (error) {
      if (error instanceof SecretBackupUnavailableError) {
        return reply.code(409).send({ error: 'secret_backup_unavailable', message: error.message });
      }
      throw error;
    }
  };

  app.post<{ Body: Parameters<typeof saveEnvVar>[2] }>('/api/env', (request, reply) =>
    withSecretBackupGuard(reply, () =>
      done(
        saveEnvVar(
          paths().settings,
          paths().secretsEnv,
          request.body,
          ctx.backupDir,
          paths().settingsLocal,
        ),
      ),
    ),
  );

  app.delete<{ Querystring: { key: string; source: EnvVar['source'] } }>(
    '/api/env',
    (request, reply) =>
      withSecretBackupGuard(reply, () =>
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
      ),
  );

  // Перенос переменной между settings.json и settings.local.json. Секреты из
  // .mcp-secrets.env и env групп так не переносятся — их природа иная: отвечаем
  // 400, кнопки для них в интерфейсе нет.
  app.post<{ Params: { key: string }; Body: { source: EnvVar['source'] } }>(
    '/api/env/:key/move',
    (request, reply) => {
      const { source } = request.body;
      if (source !== 'settings' && source !== 'settings-local') {
        return reply.code(400).send({
          error: 'not_movable',
          message: 'Переносить можно только переменные из settings.json / settings.local.json.',
        });
      }

      return done(
        moveEnvVar(
          paths().settings,
          paths().secretsEnv,
          request.params.key,
          source,
          ctx.backupDir,
          paths().settingsLocal,
        ),
      );
    },
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

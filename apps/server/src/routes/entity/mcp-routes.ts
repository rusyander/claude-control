import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../../context.ts';
import {
  readMcpServers,
  saveMcpServer,
  deleteMcpServer,
  migrateMcpServerIdentity,
  checkMcpHealth,
  listMcpServerTools,
  assertMcpDraft,
  InvalidMcpDraftError,
  McpServerExistsError,
  McpServerNotFoundError,
} from '../../domains/mcp.ts';
import { readEnvLookup } from '../../domains/env.ts';
import type { EnvLookup } from '../../domains/mcp-client.ts';
import {
  startOAuth,
  finishOAuth,
  clearOAuth,
  hasOAuthTokens,
  oauthProviderFor,
  oauthCallbackPage,
} from '../../domains/mcp-oauth.ts';
import { done } from '../write-result.ts';
import type { ClaudePaths } from './shared.ts';

type McpServer = ReturnType<typeof readMcpServers>[number];

const NOT_FOUND = { error: 'not_found', message: 'Сервер не найден' } as const;

/** MCP-серверы (~/.claude.json) вместе с их интерактивным входом (OAuth). */
export function registerMcpRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const paths = (): ClaudePaths => ctx.location.paths;

  /**
   * Ошибка домена → статус с причиной. Черновик не по правилу — 400 (раньше
   * тело без транспорта или без команды уезжало в файл как есть); сервера нет —
   * 404, файл не переписан; имя занято (в том числе выключенным тёзкой) — 409,
   * как у скиллов и у MCP чужих провайдеров: писать поверх значит потерять чужой
   * сервер, а решение — за человеком.
   */
  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (
      error instanceof InvalidMcpDraftError ||
      error instanceof McpServerNotFoundError ||
      error instanceof McpServerExistsError
    ) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    throw error;
  };

  app.get('/api/mcp', () => readMcpServers(paths().mcpConfig, ctx.store, paths().appData));

  app.post<{ Body: unknown }>('/api/mcp', (request, reply) => {
    try {
      // Форму тела проверяет домен (assertMcpDraft) — маршрут правило не дублирует.
      const draft = request.body;
      assertMcpDraft(draft);
      const backupPath = saveMcpServer(paths().mcpConfig, null, draft, ctx.backupDir);
      // Имя могло принадлежать серверу, удалённому мимо панели, — его отметка проверки не наша.
      ctx.store.forgetMcpHealth(draft.name);
      return done(backupPath);
    } catch (error) {
      return fail(reply, error);
    }
  });

  // Правка сервера. Смена имени — это смена идентификатора, поэтому вместе с
  // записью в конфиге переезжают отметки состояния (группы, выключение, итог
  // проверки связи) и сохранённый OAuth-вход: иначе сервер выпадает из групп, а
  // токен остаётся в хранилище под мёртвым ключом.
  app.put<{ Params: { id: string }; Body: unknown }>('/api/mcp/:id', async (request, reply) => {
    let saved: { backupPath: string | undefined; name: string };
    try {
      const draft = request.body;
      assertMcpDraft(draft);
      saved = {
        backupPath: saveMcpServer(paths().mcpConfig, request.params.id, draft, ctx.backupDir),
        name: draft.name,
      };
    } catch (error) {
      // Отказ до записи: перенос отметок и токена не запускаем — иначе
      // состояние переехало бы на имя, которого сервер так и не получил.
      return fail(reply, error);
    }

    await migrateMcpServerIdentity(ctx.store, paths().appData, request.params.id, saved.name);

    return done(saved.backupPath);
  });

  // Удаление уносит и сохранённый вход: карточки с кнопкой «Выйти» больше нет,
  // так что refresh-токен третьей стороны иначе остался бы в хранилище навсегда
  // и достался бы новому серверу, заведённому под тем же именем.
  app.delete<{ Params: { id: string } }>('/api/mcp/:id', async (request, reply) => {
    let backupPath: string | undefined;
    try {
      backupPath = deleteMcpServer(paths().mcpConfig, request.params.id, ctx.backupDir);
    } catch (error) {
      return fail(reply, error);
    }

    await clearOAuth(paths().appData, request.params.id);
    // Вместе с записью и токеном уходит и след в state.json (группы, отметки,
    // итог проверки): иначе карточка группы показывает участника-призрака, а
    // сервер, заведённый потом под тем же именем, молча получает чужие группы.
    ctx.store.removeEntity('mcp', request.params.id);

    return done(backupPath);
  });

  const findMcpServer = (id: string): McpServer | undefined =>
    readMcpServers(paths().mcpConfig, ctx.store, paths().appData).find((item) => item.id === id);

  /**
   * Сервер с сохранёнными токенами опрашивается от его имени: SDK подставит
   * токен и обновит его при истечении. У stdio входа нет — там undefined.
   */
  const authProviderFor = (server: McpServer): ReturnType<typeof oauthProviderFor> | undefined =>
    server.transport !== 'stdio' && hasOAuthTokens(paths().appData, server.id)
      ? oauthProviderFor(server, paths().appData)
      : undefined;

  /**
   * Значения для ссылок ${VAR} в записи сервера: окружение панели, поверх него
   * переменные из settings.json / settings.local.json и файла секретов — то, что
   * человек настраивает в разделе «Переменные». Claude Code подставляет их из
   * своего окружения; панель — из того же плюс своих файлов, иначе проверка шла
   * бы к серверу с буквальным `${TOKEN}` в заголовке и получала 401.
   */
  const envLookup = (): EnvLookup => ({
    ...process.env,
    ...readEnvLookup(paths().settings, paths().secretsEnv, paths().settingsLocal),
  });

  /**
   * Проверка живости конкретного сервера — запускает его и говорит по протоколу
   * MCP. Итог запоминается в состоянии панели: карточка показывает его после
   * перезагрузки, обзор считает по нему отвечающие и упавшие серверы.
   */
  app.post<{ Params: { id: string } }>('/api/mcp/:id/health', async (request, reply) => {
    const server = findMcpServer(request.params.id);
    if (!server) return reply.code(404).send(NOT_FOUND);

    const result = await checkMcpHealth(
      server,
      30_000,
      authProviderFor(server),
      ctx.store.getSettings().mcpNetworkTimeoutMs,
      envLookup(),
    );
    if (result.health !== 'disabled') ctx.store.saveMcpHealth(server.id, result);

    return result;
  });

  /**
   * Список инструментов сервера — имена и описания для помощника отбора прав.
   * Тот же провайдер OAuth и та же подстановка переменных, что у проверки связи.
   */
  app.post<{ Params: { id: string } }>('/api/mcp/:id/tools', async (request, reply) => {
    const server = findMcpServer(request.params.id);
    if (!server) return reply.code(404).send(NOT_FOUND);

    return listMcpServerTools(
      server,
      30_000,
      authProviderFor(server),
      ctx.store.getSettings().mcpNetworkTimeoutMs,
      envLookup(),
    );
  });

  /**
   * Начать интерактивный вход. Ответ либо `authorized` (токены уже есть), либо
   * `redirect` с адресом, который интерфейс откроет в отдельном окне.
   */
  app.post<{ Params: { id: string } }>('/api/mcp/:id/oauth/start', async (request, reply) => {
    const server = findMcpServer(request.params.id);
    if (!server) return reply.code(404).send(NOT_FOUND);

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
}

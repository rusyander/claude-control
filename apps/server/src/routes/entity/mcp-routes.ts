import type { FastifyInstance, FastifyReply } from 'fastify';
import type { McpServerDraft } from '@claude-control/contracts';
import type { ServerContext } from '../../context.ts';
import {
  readMcpServers,
  saveMcpServer,
  deleteMcpServer,
  migrateMcpServerIdentity,
  checkMcpHealth,
  listMcpServerTools,
  McpServerExistsError,
} from '../../domains/mcp.ts';
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

  app.post<{ Body: Partial<McpServerDraft> }>('/api/mcp', (request, reply) => {
    // Имя сервера — его идентификатор в конфиге Claude Code. Без него запись
    // уходила в файл настоящего `~/.claude` и падала пятисоткой уже там.
    if (!request.body.name) {
      return reply.code(400).send({ message: 'Не указано имя MCP-сервера' });
    }

    try {
      return done(
        saveMcpServer(paths().mcpConfig, null, request.body as McpServerDraft, ctx.backupDir),
      );
    } catch (error) {
      return mcpExists(reply, error);
    }
  });

  // Правка сервера. Смена имени — это смена идентификатора, поэтому вместе с
  // записью в конфиге переезжают отметки состояния (группы, выключение) и
  // сохранённый OAuth-вход: иначе сервер выпадает из групп, а токен остаётся в
  // хранилище под мёртвым ключом.
  app.put<{ Params: { id: string }; Body: Partial<McpServerDraft> }>(
    '/api/mcp/:id',
    async (request, reply) => {
      // То же, что и при создании: имя — идентификатор сервера в конфиге, и без
      // него правка уходила в запись и падала пятисоткой уже там.
      if (!request.body.name) {
        return reply.code(400).send({ message: 'Не указано имя MCP-сервера' });
      }

      const draft = request.body as McpServerDraft;

      let backupPath: string | undefined;
      try {
        backupPath = saveMcpServer(paths().mcpConfig, request.params.id, draft, ctx.backupDir);
      } catch (error) {
        // Отказ до записи: перенос отметок и токена не запускаем — иначе
        // состояние переехало бы на имя, которого сервер так и не получил.
        return mcpExists(reply, error);
      }

      await migrateMcpServerIdentity(ctx.store, paths().appData, request.params.id, draft.name);

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

  /** Проверка живости конкретного сервера — запускает его и говорит по протоколу MCP. */
  app.post<{ Params: { id: string } }>('/api/mcp/:id/health', async (request, reply) => {
    const server = findMcpServer(request.params.id);
    if (!server) return reply.code(404).send(NOT_FOUND);

    return checkMcpHealth(
      server,
      30_000,
      authProviderFor(server),
      ctx.store.getSettings().mcpNetworkTimeoutMs,
    );
  });

  /**
   * Список инструментов сервера — имена и описания для помощника отбора прав.
   * Тот же провайдер OAuth, что и у проверки связи.
   */
  app.post<{ Params: { id: string } }>('/api/mcp/:id/tools', async (request, reply) => {
    const server = findMcpServer(request.params.id);
    if (!server) return reply.code(404).send(NOT_FOUND);

    return listMcpServerTools(
      server,
      30_000,
      authProviderFor(server),
      ctx.store.getSettings().mcpNetworkTimeoutMs,
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

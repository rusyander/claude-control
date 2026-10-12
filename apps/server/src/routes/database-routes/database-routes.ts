import { isAbsolute } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DbConnectionsInfo } from '@agentdeck/contracts';
import {
  dbConnectionBodySchema,
  dbConnectionRemoveBodySchema,
  dbMcpBodySchema,
  dbQueryBodySchema,
} from '@agentdeck/contracts/request-bodies';
import type { ServerContext } from '../../context.ts';
import { ComposeReader, execDocker, findComposeFile } from '../../domains/compose/compose.ts';
import type { DockerExec } from '../../domains/compose/compose.ts';
import {
  DATABASE_MCP_ID,
  DatabaseBridgeError,
  DbError,
  ManualConnectionNotFoundError,
  QUERY_TIMEOUT_MS,
  SqlRefusedError,
  describeMigrations,
  isDatabaseMcpRegistered,
  listConnections,
  readSchema,
  registerDatabaseMcp,
  removeManualConnection,
  runQuery,
  saveManualConnection,
  targetOf,
  unregisterDatabaseMcp,
  type ComposeDbInput,
} from '../../domains/database/database.ts';
import { isProjectOrCopy } from '../../domains/project-tests/project-tests.ts';
import { parseBody } from '../../lib/request-body.ts';

/**
 * База данных проекта: вкладка «База данных» окна «Окружение» и переходник MCP
 * агента (`tools/mcp/database.mjs`) — оба ходят сюда.
 *
 * Всё, что соединяется с базой, — только у проектов из раздела «Проекты» (как
 * подъём Compose): реквизиты берутся из файлов проекта, и подключаться по
 * адресу из произвольного каталога панель не станет. Отказы несут свой `code`,
 * а не `messageCode`: тексты для них — у клиента.
 */
export interface DatabaseRouteDeps {
  exec?: DockerExec;
  selfBaseUrl?: string;
}

const DB_ERROR_STATUS: Record<DbError['kind'], number> = {
  connect: 502,
  auth: 502,
  'database-missing': 502,
  timeout: 504,
  'read-only': 422,
  permission: 422,
  query: 422,
};

export function registerDatabaseRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: DatabaseRouteDeps = {},
): void {
  const reader = new ComposeReader(deps.exec ?? execDocker);
  const appData = (): string => ctx.location.paths.appData;
  const selfBaseUrl = deps.selfBaseUrl ?? `http://127.0.0.1:${process.env.PORT ?? 5178}`;
  const bridgeOptions = () => ({
    mcpConfigPath: ctx.location.paths.mcpConfig,
    backupDir: ctx.backupDir,
    selfBaseUrl,
    store: ctx.store,
  });

  /** Путь к проекту: абсолютный и свой. Иначе ответ уже отправлен. */
  const ownProject = (path: string | undefined, reply: FastifyReply): string | undefined => {
    if (!path || !isAbsolute(path)) {
      void reply.code(400).send({
        code: 'db-path-required',
        message: 'Нужен абсолютный путь к каталогу проекта',
      });
      return undefined;
    }
    const projects = ctx.store.getProjects().map((project) => project.path);
    if (!isProjectOrCopy(path, projects)) {
      void reply.code(403).send({
        code: 'db-project-unregistered',
        message:
          'С базой панель работает только у проектов из раздела «Проекты», каталогов внутри них и копий их веток.',
      });
      return undefined;
    }
    return path;
  };

  /** Сервисы Compose с окружением и состоянием. Docker нет или файл не принят — без них. */
  const composeOf = async (root: string): Promise<ComposeDbInput | undefined> => {
    const location = findComposeFile(root);
    if (!location) return undefined;
    const { stack } = await reader.declared(location);
    if (!stack) return undefined;
    const live = await reader.describe(root);
    const states = new Map(live.services.map((service) => [service.name, service.state]));
    return {
      file: location.file,
      services: stack.services.map((service) => ({
        name: service.name,
        ...(service.image ? { image: service.image } : {}),
        ports: service.ports,
        environment: service.environment,
        ...(states.get(service.name) ? { state: states.get(service.name) } : {}),
      })),
    };
  };

  const describe = async (root: string): Promise<DbConnectionsInfo> => {
    const { found, unsupported } = listConnections(appData(), root, await composeOf(root));
    return {
      projectPath: root,
      connections: found.map((connection) => connection.info),
      unsupported,
      mcpRegistered: isDatabaseMcpRegistered(ctx.location.paths.mcpConfig, ctx.store),
    };
  };

  const connectionOf = async (root: string, id: string | undefined, reply: FastifyReply) => {
    const { found } = listConnections(appData(), root, await composeOf(root));
    const connection = found.find((item) => item.info.id === id);
    if (connection) return connection;
    void reply.code(404).send({
      code: 'db-connection-unknown',
      message: `Подключения «${id ?? ''}» в проекте нет — список мог измениться.`,
      connections: found.map((item) => item.info.id),
    });
    return undefined;
  };

  const failDb = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof SqlRefusedError) {
      return reply.code(400).send({
        code: 'db-sql-refused',
        refusal: error.refusal,
        message: `Запрос не пропущен: только чтение, один оператор (${error.refusal.reason}).`,
      });
    }
    if (error instanceof DbError) {
      return reply.code(DB_ERROR_STATUS[error.kind]).send({
        code: 'db-error',
        kind: error.kind,
        message: error.message,
        ...(error.sqlState ? { sqlState: error.sqlState } : {}),
        ...(error.position ? { position: error.position } : {}),
      });
    }
    throw error;
  };

  app.get<{ Querystring: { path?: string } }>(
    '/api/database/connections',
    async (request, reply) => {
      const root = ownProject(request.query.path, reply);
      if (!root) return reply;
      return describe(root);
    },
  );

  app.post('/api/database/connections', async (request, reply) => {
    const body = parseBody(dbConnectionBodySchema, request.body, reply);
    if (!body) return reply;
    const root = ownProject(body.path, reply);
    if (!root) return reply;
    try {
      const id = saveManualConnection(appData(), root, body);
      return { ...(await describe(root)), savedId: id };
    } catch (error) {
      if (error instanceof ManualConnectionNotFoundError) {
        return reply.code(404).send({
          code: 'db-connection-unknown',
          message: 'Такого своего подключения нет — его могли удалить.',
        });
      }
      throw error;
    }
  });

  app.post('/api/database/connections/remove', async (request, reply) => {
    const body = parseBody(dbConnectionRemoveBodySchema, request.body, reply);
    if (!body) return reply;
    const root = ownProject(body.path, reply);
    if (!root) return reply;
    if (!body.id.startsWith('manual:')) {
      return reply.code(400).send({
        code: 'db-connection-not-manual',
        message: 'Найденное в файлах проекта подключение убирают в самом файле, а не в панели.',
      });
    }
    try {
      removeManualConnection(appData(), root, body.id);
    } catch (error) {
      if (!(error instanceof ManualConnectionNotFoundError)) throw error;
    }
    return describe(root);
  });

  app.get<{ Querystring: { path?: string; connectionId?: string } }>(
    '/api/database/schema',
    async (request, reply) => {
      const root = ownProject(request.query.path, reply);
      if (!root) return reply;
      const connection = await connectionOf(root, request.query.connectionId, reply);
      if (!connection) return reply;
      try {
        return await readSchema(targetOf(connection), connection.info.id);
      } catch (error) {
        return failDb(reply, error);
      }
    },
  );

  app.post('/api/database/query', async (request, reply) => {
    const body = parseBody(dbQueryBodySchema, request.body, reply);
    if (!body) return reply;
    const root = ownProject(body.path, reply);
    if (!root) return reply;
    const connection = await connectionOf(root, body.connectionId, reply);
    if (!connection) return reply;
    try {
      return await runQuery(targetOf(connection), body.sql, body.mode ?? 'run');
    } catch (error) {
      return failDb(reply, error);
    }
  });

  app.get<{ Querystring: { path?: string; connectionId?: string } }>(
    '/api/database/migrations',
    async (request, reply) => {
      const root = ownProject(request.query.path, reply);
      if (!root) return reply;
      // Без подключения — только файлы: что лежит в проекте, видно и так.
      if (!request.query.connectionId) return describeMigrations(root, undefined, QUERY_TIMEOUT_MS);
      const connection = await connectionOf(root, request.query.connectionId, reply);
      if (!connection) return reply;
      return describeMigrations(root, targetOf(connection), QUERY_TIMEOUT_MS);
    },
  );

  app.get('/api/database/mcp', () => ({
    name: DATABASE_MCP_ID,
    connected: isDatabaseMcpRegistered(ctx.location.paths.mcpConfig, ctx.store),
  }));

  app.post('/api/database/mcp', async (request, reply) => {
    const body = parseBody(dbMcpBodySchema, request.body, reply);
    if (!body) return reply;
    try {
      if (body.enabled) registerDatabaseMcp(bridgeOptions());
      else unregisterDatabaseMcp(bridgeOptions());
    } catch (error) {
      if (error instanceof DatabaseBridgeError) {
        return reply.code(409).send({ code: error.code, message: error.message });
      }
      throw error;
    }
    return { name: DATABASE_MCP_ID, connected: body.enabled };
  });
}

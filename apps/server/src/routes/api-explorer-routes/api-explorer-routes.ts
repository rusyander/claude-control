import { isAbsolute } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ApiHistoryEntry, ProjectRunnerView } from '@agentdeck/contracts';
import {
  apiPathBodySchema,
  apiPostmanBodySchema,
  apiSendBodySchema,
  apiSettingsBodySchema,
  apiSourceBodySchema,
  apiSourceRemoveBodySchema,
} from '@agentdeck/contracts/request-bodies';
import type { ServerContext } from '../../context.ts';
import {
  ApiSendError,
  ApiSpecError,
  addCollection,
  addUrlSource,
  clearHistory,
  describeExplorer,
  loadSource,
  loadSpecUrl,
  parseSpecText,
  readProject,
  removeCollection,
  removeUrlSource,
  runningServices,
  sendAndRecord,
  setAuth,
  setBaseUrl,
} from '../../domains/api-explorer/api-explorer.ts';
import type { sendRequest } from '../../domains/api-explorer/send.ts';
import { isProjectOrCopy } from '../../domains/project-tests/project-tests.ts';
import { parseBody } from '../../lib/request-body.ts';

/**
 * Вкладка «API» окна «Окружение»: источники контракта, разбор, отправка запроса
 * через сервер панели и история. Только у проектов из раздела «Проекты» (как
 * база и Compose). Отказы несут свой `code` (`api-*`), тексты — у клиента.
 */
export interface ApiExplorerRouteDeps {
  /** Цели «Dev-сервера» — работающие с адресом становятся кандидатами в базовый адрес. */
  runs?: () => ProjectRunnerView[];
  send?: typeof sendRequest;
}

const SPEC_ERROR_STATUS: Record<ApiSpecError['kind'], number> = {
  unreadable: 422,
  'not-a-spec': 422,
  'too-big': 413,
  fetch: 502,
  missing: 404,
};

const SEND_ERROR_STATUS: Record<ApiSendError['kind'], number> = {
  'bad-url': 400,
  connect: 502,
  timeout: 504,
};

export function registerApiExplorerRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: ApiExplorerRouteDeps = {},
): void {
  const appData = (): string => ctx.location.paths.appData;
  const services = (root: string) => runningServices(root, deps.runs?.() ?? []);

  /** Путь к проекту: абсолютный и свой. Иначе ответ уже отправлен. */
  const ownProject = (path: string | undefined, reply: FastifyReply): string | undefined => {
    if (!path || !isAbsolute(path)) {
      void reply.code(400).send({
        code: 'api-path-required',
        message: 'Нужен абсолютный путь к каталогу проекта',
      });
      return undefined;
    }
    const projects = ctx.store.getProjects().map((project) => project.path);
    if (!isProjectOrCopy(path, projects)) {
      void reply.code(403).send({
        code: 'api-project-unregistered',
        message:
          'Запросы к API панель шлёт только у проектов из раздела «Проекты», каталогов внутри них и копий их веток.',
      });
      return undefined;
    }
    return path;
  };

  const failSpec = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof ApiSpecError) {
      return reply.code(SPEC_ERROR_STATUS[error.kind]).send({
        code: 'api-spec-failed',
        kind: error.kind,
        message: error.message,
      });
    }
    throw error;
  };

  const describe = (root: string, fresh = false) =>
    describeExplorer(appData(), root, services(root), fresh);

  app.get<{ Querystring: { path?: string; fresh?: string } }>(
    '/api/api-explorer',
    async (request, reply) => {
      const root = ownProject(request.query.path, reply);
      if (!root) return reply;
      return describe(root, request.query.fresh === '1');
    },
  );

  app.get<{ Querystring: { path?: string; sourceId?: string; fresh?: string } }>(
    '/api/api-explorer/spec',
    async (request, reply) => {
      const root = ownProject(request.query.path, reply);
      if (!root) return reply;
      if (!request.query.sourceId) {
        return reply.code(400).send({ code: 'api-source-required', message: 'Нужен sourceId' });
      }
      try {
        return await loadSource(
          appData(),
          root,
          request.query.sourceId,
          request.query.fresh === '1',
        );
      } catch (error) {
        return failSpec(reply, error);
      }
    },
  );

  // Адрес добавляется, только если по нему и правда контракт: иначе в списке
  // источников висел бы мусор, который при открытии всё равно упадёт.
  app.post('/api/api-explorer/sources', async (request, reply) => {
    const body = parseBody(apiSourceBodySchema, request.body, reply);
    if (!body) return reply;
    const root = ownProject(body.path, reply);
    if (!root) return reply;
    try {
      await loadSpecUrl(body.url, `url:${body.url}`, true);
    } catch (error) {
      return failSpec(reply, error);
    }
    addUrlSource(appData(), root, body.url);
    return { ...(await describe(root)), sourceId: `url:${body.url}` };
  });

  app.post('/api/api-explorer/sources/remove', async (request, reply) => {
    const body = parseBody(apiSourceRemoveBodySchema, request.body, reply);
    if (!body) return reply;
    const root = ownProject(body.path, reply);
    if (!root) return reply;
    if (body.sourceId.startsWith('url:'))
      removeUrlSource(appData(), root, body.sourceId.slice('url:'.length));
    else if (body.sourceId.startsWith('postman:'))
      removeCollection(appData(), root, body.sourceId.slice('postman:'.length));
    else {
      return reply.code(400).send({
        code: 'api-source-not-removable',
        message: 'Файл контракта из проекта убирают в самом проекте, а не в панели.',
      });
    }
    return describe(root);
  });

  app.post('/api/api-explorer/postman', { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    const body = parseBody(apiPostmanBodySchema, request.body, reply);
    if (!body) return reply;
    const root = ownProject(body.path, reply);
    if (!root) return reply;
    let title: string;
    try {
      const spec = parseSpecText(body.content, 'postman:import');
      if (spec.format !== 'postman') {
        return reply.code(422).send({
          code: 'api-not-postman',
          message:
            'Это контракт OpenAPI, а не коллекция Postman — добавьте его файлом или адресом.',
        });
      }
      title = spec.title;
    } catch (error) {
      return failSpec(reply, error);
    }
    const id = addCollection(appData(), root, body.name || title, body.content);
    return { ...(await describe(root)), sourceId: `postman:${id}` };
  });

  app.post('/api/api-explorer/send', { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    const body = parseBody(apiSendBodySchema, request.body, reply);
    if (!body) return reply;
    const root = ownProject(body.path, reply);
    if (!root) return reply;
    try {
      return await sendAndRecord(appData(), root, body, deps.send);
    } catch (error) {
      if (error instanceof ApiSendError) {
        return reply.code(SEND_ERROR_STATUS[error.kind]).send({
          code: 'api-send-failed',
          kind: error.kind,
          ...(error.detail ? { detail: error.detail } : {}),
          message: error.message,
        });
      }
      throw error;
    }
  });

  app.put('/api/api-explorer/settings', async (request, reply) => {
    const body = parseBody(apiSettingsBodySchema, request.body, reply);
    if (!body) return reply;
    const root = ownProject(body.path, reply);
    if (!root) return reply;
    if (body.baseUrl !== undefined) setBaseUrl(appData(), root, body.baseUrl);
    if (body.auth !== undefined) setAuth(appData(), root, body.auth);
    return describe(root);
  });

  app.get<{ Querystring: { path?: string } }>(
    '/api/api-explorer/history',
    (request, reply): ApiHistoryEntry[] | FastifyReply => {
      const root = ownProject(request.query.path, reply);
      if (!root) return reply;
      return readProject(appData(), root).history ?? [];
    },
  );

  app.post('/api/api-explorer/history/clear', (request, reply) => {
    const body = parseBody(apiPathBodySchema, request.body, reply);
    if (!body) return reply;
    const root = ownProject(body.path, reply);
    if (!root) return reply;
    clearHistory(appData(), root);
    return [];
  });
}

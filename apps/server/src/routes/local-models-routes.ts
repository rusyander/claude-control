import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  localConnectBodySchema,
  localKitBodySchema,
  localPullBodySchema,
} from '@agentdeck/contracts/local-models';
import type { ServerContext } from '../context.ts';
import { readApiToken } from '../lib/api-token.ts';
import { parseBody } from '../lib/request-body.ts';
import { errorBody } from '../lib/server-text.ts';
import type { Inject } from '../domains/local-models/connect.ts';
import type { LocalModels } from '../domains/local-models/service.ts';
import type { KitService } from '../domains/kit/service.ts';

/**
 * «Локальные модели»: что за карта, что подойдёт, что стоит; скачать, удалить,
 * замерить, включить агентам.
 *
 * Долгое (сервер моделей, модель, Qwen Code) идёт работой с прогрессом:
 * маршрут отвечает сразу номером работы, страница опрашивает `GET /api/local-models`.
 * Включение агентам — через маршруты КОНТУРА изнутри (`inject`): так проходят
 * те же проверки тела, транзакция активации и проба, что и у мастера контура.
 */
export function registerLocalModelsRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  local: LocalModels,
  kit: KitService,
): void {
  /**
   * Запрос к своим маршрутам. Заголовок человека передаётся дальше; если его нет
   * (работа закончилась после того, как вкладку закрыли) — свой токен, когда
   * удалённый доступ включён.
   */
  const injectFor =
    (request: FastifyRequest): Inject =>
    async ({ method, url, payload }) => {
      const human = request.headers.authorization;
      const auth =
        human ??
        (ctx.store.getSettings().remoteAccess.enabled ? `Bearer ${readApiToken()}` : undefined);
      const answer = await app.inject({
        method,
        url,
        headers: auth ? { authorization: auth } : {},
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
      let body: unknown;
      try {
        body = answer.json();
      } catch {
        body = undefined;
      }
      return { status: answer.statusCode, body };
    };

  const refuse = (reply: FastifyReply, error: unknown, status = 409): FastifyReply =>
    reply.code(status).send(errorBody(error, 'error'));

  app.get('/api/local-models', async (request) => {
    const info = await local.describe();
    // Режим набора — у страницы «Набор панели» (В2); здесь только его отражение.
    const modes = { claude: kit.modeOf('claude'), qwen: kit.modeOf('qwen') };
    return {
      ...info,
      kit: { ...info.kit, ...modes },
      connect: await local.describeConnect(injectFor(request)),
    };
  });

  app.post('/api/local-models/hardware/refresh', () => local.refreshHardware());

  app.post('/api/local-models/runtime/install', () => local.installRuntime());

  app.post<{ Body: unknown }>('/api/local-models/server/start', async (request, reply) => {
    const tag = (request.body as { tag?: unknown } | undefined)?.tag;
    try {
      return await local.startServer(typeof tag === 'string' && tag ? tag : undefined);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post('/api/local-models/server/stop', async (_request, reply) => {
    try {
      return await local.stopServer();
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post<{ Body: unknown }>('/api/local-models/pull', (request, reply) => {
    const body = parseBody(localPullBodySchema, request.body, reply);
    if (!body) return reply;
    const connect = (request.body as { connect?: unknown }).connect === true;
    try {
      return local.pull(body.tag, connect ? injectFor(request) : undefined);
    } catch (error) {
      return refuse(reply, error, 404);
    }
  });

  app.post<{ Body: unknown }>('/api/local-models/import', (request, reply) => {
    const body = parseBody(localPullBodySchema, request.body, reply);
    if (!body) return reply;
    return local.importFromSystem(body.tag);
  });

  app.delete<{ Params: { tag: string } }>(
    '/api/local-models/models/:tag',
    async (request, reply) => {
      try {
        await local.remove(decodeURIComponent(request.params.tag));
        return { ok: true };
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  app.post<{ Body: unknown }>('/api/local-models/bench', async (request, reply) => {
    const body = parseBody(localPullBodySchema, request.body, reply);
    if (!body) return reply;
    try {
      return await local.bench(body.tag);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post<{ Body: unknown }>('/api/local-models/connect', async (request, reply) => {
    const body = parseBody(localConnectBodySchema, request.body, reply);
    if (!body) return reply;
    try {
      await local.connect(injectFor(request), body.tag);
      return await local.describeConnect(injectFor(request));
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post('/api/local-models/disconnect', async (request, reply) => {
    try {
      await local.disconnect(injectFor(request));
      return await local.describeConnect(injectFor(request));
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post('/api/local-models/qwen-code/install', () => local.installQwen());

  app.put<{ Body: unknown }>('/api/local-models/kit', (request, reply) => {
    const body = parseBody(localKitBodySchema, request.body, reply);
    if (!body) return reply;
    try {
      kit.setMode(body.provider, body.mode);
    } catch (error) {
      return refuse(reply, error, 400);
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/local-models/jobs/:id/cancel', (request, reply) => {
    try {
      local.cancel(request.params.id);
      return { ok: true };
    } catch (error) {
      return refuse(reply, error, 404);
    }
  });
}

import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  localChoiceBodySchema,
  localClaudeBodySchema,
  localConnectBodySchema,
  localCustomBodySchema,
  localDeviceBodySchema,
  localKeepLoadedBodySchema,
  localKeepAwakeBodySchema,
  localKitBodySchema,
  localMcpMeasureBodySchema,
  localMcpPickBodySchema,
  localModelBodySchema,
  localPullBodySchema,
  localRemoveQuerySchema,
} from '@agentdeck/contracts/local-models';
import type { ServerContext } from '../../context.ts';
import { readApiToken } from '../../lib/api-token/api-token.ts';
import { parseBody } from '../../lib/request-body.ts';
import { errorBody } from '../../lib/server-text/server-text.ts';
import { localError } from '../../domains/local-models/errors.ts';
import type { Inject } from '../../domains/local-models/connect.ts';
import type { LocalModels } from '../../domains/local-models/service.ts';
import type { KitService } from '../../domains/kit/service.ts';

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

  /**
   * Поднять сервер. Тело необязательно: пусто — модель, что уже стоит или лучшая из
   * скачанных; `quant`, `context`, `kvCache` называют запуск явно и запоминаются.
   */
  app.post<{ Body: unknown }>('/api/local-models/server/start', async (request, reply) => {
    const raw = request.body ?? {};
    const body = parseBody(localModelBodySchema.partial(), raw, reply);
    if (!body) return reply;
    try {
      return await local.startServer(body);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /** Квантования модели: живой список из репозитория, что скачано и как ляжет на карту. */
  app.get<{ Querystring: { tag?: string } }>('/api/local-models/quants', async (request, reply) => {
    const tag = request.query.tag ?? '';
    try {
      return await local.quants(tag);
    } catch (error) {
      return refuse(reply, error, 404);
    }
  });

  /**
   * Выбор квантования и окна для модели: запоминается, им же поднимется каждый
   * следующий запуск. Идущий сервер перезапускается работой «restart»; выбор, который
   * не влезает на карту сейчас, отклоняется с цифрами.
   */
  app.put<{ Body: unknown }>('/api/local-models/choice', async (request, reply) => {
    const body = parseBody(localChoiceBodySchema, request.body, reply);
    if (!body) return reply;
    try {
      return await local.setChoice(body);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /** «Любая модель»: репозиторий Hugging Face → запись с квантованиями и устройством, без скачивания. */
  app.post<{ Body: unknown }>('/api/local-models/custom', async (request, reply) => {
    const body = parseBody(localCustomBodySchema, request.body, reply);
    if (!body) return reply;
    try {
      return await local.addCustom(body.input);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /**
   * Что сервер моделей делает с запросом чата: этап, разбор промпта, токены ответа, тишина
   * (L6). Дёшево: без `/props` и без опроса слотов — их держит присмотр за запросом, а
   * спящий сервер опрос слотов разбудил бы. Плюс замер слоя против окна (ревью B1): действие
   * подбирается, только когда слой не влезает, и по железу из кеша — карта опрашивается заново
   * лишь по истечении его срока.
   */
  app.get('/api/local-models/activity', () => local.activity());

  /** «Перезапустить» из чата: тот же сервер заново, теми же параметрами. */
  app.post('/api/local-models/server/restart', async (_request, reply) => {
    try {
      return await local.restartServer();
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
      return local.pull(body, connect ? injectFor(request) : undefined);
    } catch (error) {
      return refuse(reply, error, 404);
    }
  });

  app.post<{ Body: unknown }>('/api/local-models/import', (request, reply) => {
    const body = parseBody(localPullBodySchema, request.body, reply);
    if (!body) return reply;
    return local.importFromSystem(body.tag);
  });

  /**
   * Удалить скачанное: `?quant=` — одно квантование, без него — модель целиком. Файл, который
   * держит сервер моделей или поднимет после идущего прогона, — 409 с причиной: сервер
   * останавливает человек, а не удаление.
   */
  app.delete<{ Params: { tag: string }; Querystring: unknown }>(
    '/api/local-models/models/:tag',
    async (request, reply) => {
      const query = parseBody(localRemoveQuerySchema, request.query, reply);
      if (!query) return reply;
      try {
        return await local.remove(decodeURIComponent(request.params.tag), query.quant);
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
      await local.connect(injectFor(request), body);
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

  app.put<{ Body: unknown }>('/api/local-models/device', async (request, reply) => {
    const body = parseBody(localDeviceBodySchema, request.body, reply);
    if (!body) return reply;
    try {
      return await local.setDevice(body.device);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.put<{ Body: unknown }>('/api/local-models/keep-loaded', async (request, reply) => {
    const body = parseBody(localKeepLoadedBodySchema, request.body, reply);
    if (!body) return reply;
    try {
      return await local.setKeepLoaded(body.keepLoaded);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.put<{ Body: unknown }>('/api/local-models/keep-awake', async (request, reply) => {
    const body = parseBody(localKeepAwakeBodySchema, request.body, reply);
    if (!body) return reply;
    try {
      return await local.setKeepAwake(body.keepAwake);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /**
   * MCP-серверы локального прогона проекта. Путь — каталог проекта (рабочий каталог
   * чата): из него читается .mcp.json. Не абсолютный или не каталог — 400, а не
   * чтение чего придётся.
   */
  const projectDir = (project: string | undefined, reply: FastifyReply): string | undefined => {
    if (project && isAbsolute(project) && existsSync(project) && statSync(project).isDirectory())
      return project;
    refuse(reply, localError('local-mcp-project', 'нужен абсолютный путь к каталогу проекта'), 400);
    return undefined;
  };

  app.get<{ Querystring: { project?: string } }>(
    '/api/local-models/mcp',
    async (request, reply) => {
      const project = projectDir(request.query.project, reply);
      if (!project) return reply;
      return local.mcpInfo(project);
    },
  );

  app.put<{ Body: unknown }>('/api/local-models/mcp', async (request, reply) => {
    const body = parseBody(localMcpPickBodySchema, request.body, reply);
    if (!body) return reply;
    const project = projectDir(body.project, reply);
    if (!project) return reply;
    return local.mcpPick(project, body.servers);
  });

  app.post<{ Body: unknown }>('/api/local-models/mcp/measure', async (request, reply) => {
    const body = parseBody(localMcpMeasureBodySchema, request.body, reply);
    if (!body) return reply;
    const project = projectDir(body.project, reply);
    if (!project) return reply;
    return await local.mcpMeasure(project, body.ids);
  });

  app.put<{ Body: unknown }>('/api/local-models/claude', async (request, reply) => {
    const body = parseBody(localClaudeBodySchema, request.body, reply);
    if (!body) return reply;
    try {
      return await local.setClaude(body.on, body.tag);
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

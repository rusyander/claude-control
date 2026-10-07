import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  kitConflictSchema,
  kitGlobalExportSchema,
  kitGlobalImportSchema,
  kitItemEnabledSchema,
  kitItemWriteSchema,
  kitModeBodySchema,
  type KitItemContent,
  type KitResponse,
} from '@agentdeck/contracts/kit';
import type { ServerContext } from '../context.ts';
import { parseBody } from '../lib/request-body.ts';
import { errorBody } from '../lib/server-text.ts';
import { KitRefusal, type KitService } from '../domains/kit/service.ts';

/**
 * Страница «Набор панели» (В2).
 *
 * `GET /api/kit` — элементы, режимы по провайдерам; `GET /api/kit/item?id=` —
 * встроенный текст и копия «моё». Запись — только в данные панели: копия
 * «моё», включено/выключено, режим, выбор в конфликте имён. `~/.claude` пишет
 * ровно один маршрут — `POST /api/kit/global/export`, по кнопке человека и с
 * резервной копией прежней версии.
 */

function refuse(reply: FastifyReply, error: unknown) {
  if (error instanceof KitRefusal) {
    return reply
      .code(error.code === 'kit-item-unknown' || error.code === 'kit-global-missing' ? 404 : 400)
      .send(errorBody(error, 'error'));
  }
  throw error;
}

export function registerKitRoutes(
  app: FastifyInstance,
  _ctx: ServerContext,
  kit: KitService,
  onChange: () => void,
): void {
  const mutate = (reply: FastifyReply, run: () => void) => {
    try {
      run();
    } catch (error) {
      return refuse(reply, error);
    }
    onChange();
    return kit.describe();
  };

  app.get('/api/kit', (): KitResponse => kit.describe());

  app.get<{ Querystring: { id?: string } }>('/api/kit/item', (request, reply) => {
    try {
      return kit.read(String(request.query.id ?? '')) satisfies KitItemContent;
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.put<{ Body: unknown }>('/api/kit/item', (request, reply) => {
    const body = parseBody(kitItemWriteSchema, request.body, reply);
    if (!body) return reply;
    return mutate(reply, () => kit.write(body.id, body.content));
  });

  app.delete<{ Querystring: { id?: string } }>('/api/kit/item', (request, reply) =>
    mutate(reply, () => kit.reset(String(request.query.id ?? ''))),
  );

  app.put<{ Body: unknown }>('/api/kit/item/enabled', (request, reply) => {
    const body = parseBody(kitItemEnabledSchema, request.body, reply);
    if (!body) return reply;
    return mutate(reply, () => kit.setEnabled(body.id, body.enabled));
  });

  app.put<{ Body: unknown }>('/api/kit/conflict', (request, reply) => {
    const body = parseBody(kitConflictSchema, request.body, reply);
    if (!body) return reply;
    return mutate(reply, () => kit.setWinner(body.id, body.winner));
  });

  app.put<{ Body: unknown }>('/api/kit/mode', (request, reply) => {
    const body = parseBody(kitModeBodySchema, request.body, reply);
    if (!body) return reply;
    return mutate(reply, () => kit.setMode(body.provider, body.mode));
  });

  app.post<{ Body: unknown }>('/api/kit/global/export', (request, reply) => {
    const body = parseBody(kitGlobalExportSchema, request.body, reply);
    if (!body) return reply;
    let backup: string | undefined;
    try {
      backup = kit.exportToGlobal(body.id);
    } catch (error) {
      return refuse(reply, error);
    }
    onChange();
    return { kit: kit.describe(), ...(backup ? { backup } : {}) };
  });

  app.post<{ Body: unknown }>('/api/kit/global/import', (request, reply) => {
    const body = parseBody(kitGlobalImportSchema, request.body, reply);
    if (!body) return reply;
    return mutate(reply, () => kit.importFromGlobal(body.kind, body.name));
  });
}

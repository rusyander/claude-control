import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  GlobalLayerApplyRequest,
  GlobalLayerResponse,
  GlobalLayerTransferRequest,
} from '@agentdeck/contracts';
import type { ServerContext } from '../context.ts';
import { GlobalLayerError, type GlobalLayer } from '../domains/global-layer/service.ts';

/**
 * Раздел настроек «Глобальный слой» (В5).
 *
 * `GET /api/global-layer` — пары с последней сверкой; заодно замечает правку
 * файла пары после сверки и перезапускает её. `POST …/:id/compare` — сверка
 * руками. `POST …/:id/transfer` — задание для чата переноса (сервер ничего не
 * запускает: задание кладётся в поле ввода, отправляет человек).
 * `GET …/:id/proposal` + `POST …/:id/apply` — дифф предложения и запись в
 * `~/.claude` с резервной копией только по подтверждению.
 */

const STATUS: Record<GlobalLayerError['code'], number> = {
  'unknown-pair': 404,
  'not-in-pair': 400,
  'stale-proposal': 409,
};

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof GlobalLayerError) {
    return reply.code(STATUS[error.code]).send({ error: error.code, message: error.message });
  }
  throw error;
}

export function registerGlobalLayerRoutes(
  app: FastifyInstance,
  _ctx: ServerContext,
  layer: GlobalLayer,
): void {
  app.get('/api/global-layer', (): GlobalLayerResponse => ({ pairs: layer.list() }));

  app.post<{ Params: { id: string } }>('/api/global-layer/:id/compare', (request, reply) => {
    try {
      return layer.compare(request.params.id);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: GlobalLayerTransferRequest }>(
    '/api/global-layer/:id/transfer',
    (request, reply) => {
      const body = request.body ?? ({} as GlobalLayerTransferRequest);
      if (body.direction !== 'toGlobal' && body.direction !== 'toPanel') {
        return reply.code(400).send({ error: 'bad-direction' });
      }
      if (body.sieve !== undefined && typeof body.sieve !== 'string') {
        return reply.code(400).send({ error: 'bad-sieve' });
      }
      try {
        return layer.transfer(request.params.id, body);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/global-layer/:id/proposal', (request, reply) => {
    try {
      return layer.proposal(request.params.id);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: GlobalLayerApplyRequest }>(
    '/api/global-layer/:id/apply',
    (request, reply) => {
      const files = request.body?.files;
      const valid =
        Array.isArray(files) &&
        files.length > 0 &&
        files.every(
          (file) =>
            typeof file?.path === 'string' &&
            typeof file.beforeSha === 'string' &&
            typeof file.afterSha === 'string',
        );
      if (!valid) return reply.code(400).send({ error: 'bad-files' });
      try {
        return layer.apply(request.params.id, { files });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}

import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import { pickPayloadSchema, sitePreviewOpenBodySchema } from '@agentdeck/contracts/site-preview';
import { parseBody } from '../../lib/request-body.ts';
import {
  SitePreviewHub,
  type SitePreviewRefusal,
  type SiteRunnerSource,
} from '../../domains/site-preview/site-preview.ts';

/** Отказ окна — статусом; текст клиент берёт из своего словаря по коду. */
const STATUS_OF: Record<SitePreviewRefusal, number> = {
  'site-not-running': 404,
  'site-not-loopback': 403,
  'site-unknown': 404,
  'pick-nonce': 403,
};

/**
 * Окно сайта в чате (D20): открыть прокси над запущенной панелью целью и принять выбор
 * элемента. Реестр запусков подаётся снаружи — окна закрываются вместе с его записями, а при
 * выходе панели — вместе с приложением.
 */
export function registerSitePreviewRoutes(
  app: FastifyInstance,
  _ctx: ServerContext,
  runner: SiteRunnerSource,
): void {
  const hub = new SitePreviewHub(runner);
  app.addHook('onClose', async () => hub.closeAll());

  app.post('/api/site-preview', async (request, reply) => {
    const body = parseBody(sitePreviewOpenBodySchema, request.body, reply);
    if (!body) return reply;
    const result = await hub.open(body.path);
    if (!result.ok) return reply.code(STATUS_OF[result.code]).send({ code: result.code });
    return result.preview;
  });

  app.post<{ Params: { siteId: string } }>(
    '/api/site-preview/:siteId/pick',
    async (request, reply) => {
      const body = parseBody(pickPayloadSchema, request.body, reply);
      if (!body) return reply;
      const result = hub.pick(request.params.siteId, body);
      if (!result.ok) return reply.code(STATUS_OF[result.code]).send({ code: result.code });
      return result.pick;
    },
  );
}

import type { FastifyInstance } from 'fastify';
import { forgeTokenForUrl } from '../../domains/integrations/forge-pick.ts';
import { readMergeRequestReview } from '../../domains/integrations/mr-review/mr-review.ts';
import type { MrReview } from '../../domains/integrations/mr-review/mr-review.types.ts';
import { appDataOf, type IntegrationsDeps } from './shared.ts';

/** Почему MR не прочитан — коды для `tests-cli delivery`, человеку их не показывают. */
type ForgeMrMiss = 'not-mr' | 'no-token' | 'unreachable';

type ForgeMrReply = { review: Omit<MrReview, 'pipeline'> } | { review: null; reason: ForgeMrMiss };

/**
 * MR глазами доставки: описание, ветки ревьюера, состояние — тем же чтением, что
 * `delivery.facts` панели (`runtime.ts`). Ключ форджа есть только у панели, поэтому
 * `tests-cli delivery` в копии группы спрашивает здесь (аудит g0 25.10, F-14): без
 * этого описание MR писали файлом для `--mr-description` и вторым разом — в фордж.
 *
 * Конвейер в ответе нарочно нет: проверка доставки его не ждёт и не читает.
 */
export function registerIntegrationForgeMrRoutes(
  app: FastifyInstance,
  deps: IntegrationsDeps,
): void {
  app.get<{ Querystring: { url?: string } }>(
    '/api/integrations/forge/mr-review',
    async (request, reply): Promise<ForgeMrReply> => {
      const url = String(request.query.url ?? '').trim();
      const token = url ? forgeTokenForUrl(deps.ctx.store, appDataOf(deps), url) : undefined;
      if (!url) return { review: null, reason: 'not-mr' };
      if (!token) return { review: null, reason: 'no-token' };
      try {
        const review = await readMergeRequestReview(url, token);
        if (!review) return { review: null, reason: 'not-mr' };
        const { pipeline: _pipeline, ...rest } = review;
        return { review: rest };
      } catch {
        void reply.code(502);
        return { review: null, reason: 'unreachable' };
      }
    },
  );
}

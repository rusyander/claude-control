import type { FastifyInstance } from 'fastify';
import {
  parseReviewLinkBody,
  REVIEW_LINK_ROUTE,
  type ReviewLinkBody,
  type ReviewLinkRefused,
} from '@agentdeck/contracts/core/review-link';
import type { EstimateReply } from '@agentdeck/contracts/core/estimate';
import { replayEstimate } from '../conductor/estimate/index.ts';
import { decideAuthority } from '../policy/authority/authority.ts';
import { proofOfBody } from './body-proof.ts';
import { apiError, commandStatus } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * `POST /v1/review-link` (этап 10, F8): ревью MR по ссылке — задача `review-link@1` на ветке MR.
 * Суд полномочий — класс оценки (`estimate`, человек): ручка создаёт задачу, как оценка, а подпись
 * устройства — над этим адресом и телом, так что подпись оценки сюда не годится и обратно.
 * 202 новая задача, 200 повтор того же `cmdId`, 422 — задачи нет, с кодом отказа
 * (`review_link_*` или `estimate-refused`), 501 — дирижёр не запущен.
 */

export interface ReviewLinkPort {
  open(
    body: ReviewLinkBody,
  ): Promise<{ status: 200 | 202; reply: EstimateReply } | ({ status: 422 } & ReviewLinkRefused)>;
}

export function registerReviewLink(
  app: FastifyInstance,
  ctx: RouteContext,
  port: () => ReviewLinkPort | undefined,
): void {
  app.post('/v1/review-link', async (request, reply) => {
    const token = ctx.tokenOf(request);
    if (token === 'none') {
      return reply.code(401).send(apiError('token-required', 'Нужен токен ядра'));
    }
    const parsed = parseReviewLinkBody(request.body);
    if (!parsed.ok) {
      return reply.code(400).send(
        apiError('bad-review-link', 'Ссылка на ревью не прошла разбор', {
          issues: parsed.issues,
        }),
      );
    }
    const replayed = replayEstimate(ctx.registry, parsed.body.cmdId);
    if (replayed) return reply.code(200).send(replayed);
    const authority = decideAuthority(
      'estimate',
      await proofOfBody(request.raw, REVIEW_LINK_ROUTE, parsed.body, token, ctx.proof),
    );
    if (!authority.allow) {
      return reply
        .code(commandStatus(authority.code))
        .send(apiError(authority.code, authority.reason));
    }
    const open = port();
    if (!open) {
      return reply
        .code(501)
        .send(
          apiError('not-wired', 'Ревью по ссылке не подключено: дирижёр не запущен в этом ядре'),
        );
    }
    const outcome = await open.open(parsed.body);
    if (outcome.status === 422) {
      return reply.code(422).send(
        apiError(outcome.code, 'Ревью по ссылке не открыто', {
          problems: outcome.problems,
        }),
      );
    }
    return reply.code(outcome.status).send(outcome.reply);
  });
}

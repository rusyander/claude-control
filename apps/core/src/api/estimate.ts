import { ESTIMATE_BODY_LIMIT, parseEstimateBody } from '@agentdeck/contracts/core/estimate';
import { estimateTask, replayEstimate } from '../conductor/estimate/index.ts';
import { decideAuthority } from '../policy/authority/authority.ts';
import { proofOfBody } from './body-proof.ts';
import { apiError, commandStatus } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';
import type { FastifyInstance } from 'fastify';

/**
 * `POST /v1/estimate` (G5): оценка = создание задачи. Суд полномочий первым (класс `estimate` —
 * человек): число страницы, пир, подпись устройства — те же части, что у `/v1/commands`, но
 * подпись — над этим адресом и телом без `proof`: подпись команды не годится оценке и обратно.
 * Дальше — `estimateTask`: 202 новая задача, 200 повтор того же `cmdId`, 422 задачи нет.
 * Среды деления (git, пробы) нет — 501 «не подключено», а не задача без предпроверки.
 */

export function registerEstimate(app: FastifyInstance, ctx: RouteContext): void {
  // Свой предел: первое слово чата несёт вложения (`attachments`), общий предел API их не вмещает.
  app.post('/v1/estimate', { bodyLimit: ESTIMATE_BODY_LIMIT }, async (request, reply) => {
    const token = ctx.tokenOf(request);
    if (token === 'none') {
      return reply.code(401).send(apiError('token-required', 'Нужен токен ядра'));
    }
    const parsed = parseEstimateBody(request.body);
    if (!parsed.ok) {
      return reply
        .code(400)
        .send(apiError('bad-estimate', 'Оценка не прошла разбор', { issues: parsed.issues }));
    }
    const replayed = replayEstimate(ctx.registry, parsed.body.cmdId);
    if (replayed) return reply.code(200).send(replayed);
    const authority = decideAuthority(
      'estimate',
      await proofOfBody(request.raw, 'POST /v1/estimate', parsed.body, token, ctx.proof),
    );
    if (!authority.allow) {
      return reply
        .code(commandStatus(authority.code))
        .send(apiError(authority.code, authority.reason));
    }
    const env = ctx.env.split();
    if (!env) {
      return reply
        .code(501)
        .send(apiError('not-wired', 'Оценка не подключена: дирижёр не запущен в этом ядре'));
    }
    const outcome = await estimateTask(parsed.body, ctx.registry, env);
    if (outcome.status === 422) {
      return reply
        .code(422)
        .send(apiError('estimate-refused', 'Задача не создана', { problems: outcome.problems }));
    }
    return reply.code(outcome.status).send(outcome.reply);
  });
}

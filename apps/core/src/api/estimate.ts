import { ESTIMATE_BODY_LIMIT, parseEstimateBody } from '@agentdeck/contracts/core/estimate';
import { leadConfigOf } from '../conductor/classify/index.ts';
import { estimateTask, replayEstimate, scenarioRefOf } from '../conductor/estimate/index.ts';
import {
  estimateGroup,
  groupItemsOf,
  groupIncomplete,
  groupMixProblem,
  groupReplyOf,
  leadEstimate,
  leadReplyOf,
} from '../conductor/intake/index.ts';
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
    // Группа, оборванная между задачами, — не повтор: недостающие пункты досоздаёт путь группы ниже.
    const cut =
      replayed !== undefined &&
      groupIncomplete(ctx.registry, parsed.body.fields, parsed.body.cmdId, replayed.taskId);
    if (replayed && !cut) {
      // Повтор задачи ведущего несёт тот же блок `lead`, что и первый ответ.
      const led = leadReplyOf(ctx.registry.live(replayed.taskId), leadConfigOf(ctx.env.layout));
      // Повтор оценки группы (W3-18) называет ту же группу и все её задачи.
      const group = groupReplyOf(ctx.registry, replayed.taskId);
      return reply
        .code(200)
        .send({ ...replayed, ...(led ? { lead: led } : {}), ...(group ? { group } : {}) });
    }
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
    // Группа (этап 11, W3-18): пункты группы — N задач тем же путём, по пункту на задачу.
    const mixed = groupMixProblem(parsed.body.fields);
    if (mixed) {
      return reply
        .code(422)
        .send(apiError('estimate-refused', 'Задача не создана', { problems: [mixed] }));
    }
    if (groupItemsOf(parsed.body.fields)) {
      const grouped = await estimateGroup(parsed.body, ctx.registry, env, (fields) =>
        leadEstimate(
          fields,
          scenarioRefOf(fields.scenario),
          (text) => ctx.registry.mask(text).text,
          leadConfigOf(ctx.env.layout),
        ),
      );
      if (grouped.status === 422) {
        return reply
          .code(422)
          .send(apiError('estimate-refused', 'Задача не создана', { problems: grouped.problems }));
      }
      const led = leadReplyOf(
        ctx.registry.live(grouped.reply.taskId),
        leadConfigOf(ctx.env.layout),
      );
      return reply.code(grouped.status).send(led ? { ...grouped.reply, lead: led } : grouped.reply);
    }
    // Приём ведущего (этап 11, W2-6): источники под маской, профиль, критерии трекера, карточка.
    const lead = leadEstimate(
      parsed.body.fields,
      scenarioRefOf(parsed.body.fields.scenario),
      (text) => ctx.registry.mask(text).text,
      leadConfigOf(ctx.env.layout),
    );
    if (lead.kind === 'refused') {
      return reply
        .code(422)
        .send(apiError('estimate-refused', 'Задача не создана', { problems: [lead.problem] }));
    }
    const outcome = await estimateTask(
      parsed.body,
      ctx.registry,
      env,
      lead.kind === 'lead' ? lead.seed : {},
    );
    if (outcome.status === 422) {
      return reply
        .code(422)
        .send(apiError('estimate-refused', 'Задача не создана', { problems: outcome.problems }));
    }
    const led =
      lead.kind === 'lead' ? lead.replyLead(ctx.registry.live(outcome.reply.taskId)) : undefined;
    return reply.code(outcome.status).send(led ? { ...outcome.reply, lead: led } : outcome.reply);
  });
}

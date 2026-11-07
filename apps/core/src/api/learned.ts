import type { FastifyInstance } from 'fastify';
import {
  learnedResetBodySchema,
  type LearnedResetBody,
  type LearnedResetReply,
} from '@agentdeck/contracts/core/commands';
import { decideAuthority } from '../policy/authority/authority.ts';
import { proofOfBody } from './body-proof.ts';
import { apiError, commandStatus } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * `POST /v1/learned/reset` — сброс ключа обучения человеком (этап 11, P140, F1). Машинная ручка,
 * как `/v1/config`: ключ — строка таблицы обучения ядра, задачи у него нет. Класс `learned-reset`
 * — `human-strict`: число страницы и чистый пир, либо подпись устройства. Модель, снявшая подъём
 * своего же ключа, вернула бы себе дешёвую ступень, которую провалы у неё отняли, — поэтому токен
 * сессии и процесс из её дерева получают отказ суда. Подъём ключа снимается целиком, пробы до
 * сброса больше не считаются; автоматического понижения нет.
 */

export const LEARNED_RESET_ROUTE = 'POST /v1/learned/reset';

/** Запись сброса и перечитывание выученного — у загрузки. */
export interface LearnedPort {
  reset(
    key: LearnedResetBody['key'],
    meta: { cmdId: string; by: string },
  ): { key: string; at: number };
  refused(cmdId: string, code: string): void;
}

export function registerLearned(
  app: FastifyInstance,
  ctx: RouteContext,
  port: () => LearnedPort | undefined,
): void {
  app.post('/v1/learned/reset', async (request, reply) => {
    const token = ctx.tokenOf(request);
    if (token === 'none') {
      return reply.code(401).send(apiError('token-required', 'Нужен токен ядра'));
    }
    const learned = port();
    if (!learned) {
      return reply.code(501).send(apiError('not-implemented', 'Обучение ядра не подключено'));
    }
    const parsed = learnedResetBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        apiError('bad-learned-reset', 'Сброс ключа обучения не прошёл разбор', {
          issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        }),
      );
    }
    const body = parsed.data;
    const authority = decideAuthority(
      'learned-reset',
      await proofOfBody(request.raw, LEARNED_RESET_ROUTE, body, token, ctx.proof),
    );
    if (!authority.allow) {
      learned.refused(body.cmdId, authority.code);
      return reply
        .code(commandStatus(authority.code))
        .send(apiError(authority.code, authority.reason));
    }
    const done = learned.reset(body.key, { cmdId: body.cmdId, by: authority.by });
    const out: LearnedResetReply = { cmdId: body.cmdId, key: done.key, at: done.at };
    return out;
  });
}

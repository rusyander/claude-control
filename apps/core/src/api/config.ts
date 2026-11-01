import type { FastifyInstance, FastifyReply } from 'fastify';
import { parseSetConfigBody } from '@agentdeck/contracts/core/config';
import { decideAuthority } from '../policy/authority/authority.ts';
import { proofOfBody } from './body-proof.ts';
import type { ConfigPort, SetConfigOutcome } from './config.types.ts';
import { apiError, commandStatus } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * `GET|POST /v1/config` — настройка ядра (00:58, G11): машинная, не команда задачи. Чтение — по
 * токену ядра или Bearer панели. Запись — тот же суд полномочий, что у команд: класс `set-config`
 * (`human-strict`: число страницы + чистый пир или подпись устройства); токен сессии и процесс
 * из дерева сессии — отказ `forged-authority` (F23: у модели нет дороги к настройке). Ключ
 * повтора — `cmdId`: тот же ключ возвращает прежний ответ, второй записи нет. Порта нет — 501.
 */

export const CONFIG_ROUTE = 'POST /v1/config';

function sendOutcome(reply: FastifyReply, outcome: SetConfigOutcome): FastifyReply {
  if (outcome.status === 200) return reply.code(200).send(outcome.reply);
  if (outcome.status === 409) {
    return reply.code(409).send(
      apiError(outcome.code, 'Настройку уже изменили: перечитайте и повторите', {
        digest: outcome.digest,
      }),
    );
  }
  return reply
    .code(422)
    .send(apiError(outcome.code, 'Настройка не принята', { issues: outcome.issues }));
}

export function registerConfig(
  app: FastifyInstance,
  ctx: RouteContext,
  port: () => ConfigPort | undefined,
): void {
  const notImplemented = apiError('not-implemented', 'Настройка ядра ещё не подключена');

  app.get('/v1/config', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const config = port();
    if (!config) return reply.code(501).send(notImplemented);
    const view = config.view();
    if ('unknown' in view) {
      return reply.code(500).send(apiError('config-unreadable', view.unknown));
    }
    return view.value;
  });

  app.post('/v1/config', async (request, reply) => {
    const token = ctx.tokenOf(request);
    if (token === 'none') {
      return reply.code(401).send(apiError('token-required', 'Нужен токен ядра'));
    }
    const config = port();
    if (!config) return reply.code(501).send(notImplemented);
    const parsed = parseSetConfigBody(request.body);
    if (!parsed.ok) {
      return reply
        .code(400)
        .send(apiError('bad-config', 'Настройка не прошла разбор', { issues: parsed.issues }));
    }
    // Повтор отвечает только тем, кто и так читает настройку: токену сессии — суд и отказ.
    if (token !== 'session') {
      const replayed = config.replay(parsed.body.cmdId);
      if (replayed) return sendOutcome(reply, replayed);
    }
    const authority = decideAuthority(
      'set-config',
      await proofOfBody(request.raw, CONFIG_ROUTE, parsed.body, token, ctx.proof),
    );
    if (!authority.allow) {
      config.refused(parsed.body.cmdId, authority.code, authority.reason);
      return reply
        .code(commandStatus(authority.code))
        .send(apiError(authority.code, authority.reason));
    }
    return sendOutcome(reply, await config.set(parsed.body, authority.by));
  });
}

import type { FastifyInstance } from 'fastify';
import { commandIssues } from '@agentdeck/contracts/core/commands';
import { localHoldBodySchema, type LocalHoldView } from '@agentdeck/contracts/core/local-hold';
import type { LocalHold } from '../routes/local/own/hold.ts';
import { apiError } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * Удержание своей модели панелью (этап 10, зона C): `GET /v1/local/hold` — что удержано и жив ли
 * сервер; `POST /v1/local/hold` — поднять модель (слот карты и память судит маршрут `local:own`);
 * `POST /v1/local/release` — освободить полным протоколом. Звонит сервер панели токеном ядра;
 * токен сеанса — отказ `forged-authority`: у модели дороги к карте нет. Порта нет — 501.
 */

export interface LocalHoldPort {
  hold: LocalHold;
  front: () => LocalHoldView['front'];
}

/** Статус отказа удержания: занятый слот и нехватка памяти — конфликт, остальное — не исполнимо. */
const REFUSAL_STATUS: Record<string, number> = {
  local_slot_busy: 409,
  route_unavailable: 409,
  model_absent: 422,
  local_start_failed: 502,
};

export function registerLocalHold(
  app: FastifyInstance,
  ctx: RouteContext,
  port: () => LocalHoldPort | undefined,
): void {
  const notImplemented = apiError('not-implemented', 'Удержание своей модели не подключено');

  /** Токен ядра или Bearer панели; сеанс — подделка полномочий, без токена — 401. */
  const writer = (token: ReturnType<RouteContext['tokenOf']>): number | undefined => {
    if (token === 'none') return 401;
    if (token === 'session') return 403;
    return undefined;
  };

  app.get('/v1/local/hold', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const local = port();
    if (!local) return reply.code(501).send(notImplemented);
    return local.hold.view(local.front());
  });

  app.post('/v1/local/hold', async (request, reply) => {
    const refused = writer(ctx.tokenOf(request));
    if (refused === 401)
      return reply.code(401).send(apiError('token-required', 'Нужен токен ядра'));
    if (refused === 403)
      return reply
        .code(403)
        .send(apiError('forged-authority', 'Сеанс модели не держит видеокарту'));
    const local = port();
    if (!local) return reply.code(501).send(notImplemented);
    const parsed = localHoldBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        apiError('bad-hold', 'Удержание модели не прошло разбор', {
          issues: commandIssues(parsed.error.issues, '', request.body),
        }),
      );
    }
    const outcome = await local.hold.hold(parsed.data);
    if (!outcome.ok) {
      return reply
        .code(REFUSAL_STATUS[outcome.code] ?? 422)
        .send(apiError(outcome.code, outcome.reason));
    }
    return { ...outcome.view, front: local.front() };
  });

  app.post('/v1/local/release', async (request, reply) => {
    const refused = writer(ctx.tokenOf(request));
    if (refused === 401)
      return reply.code(401).send(apiError('token-required', 'Нужен токен ядра'));
    if (refused === 403)
      return reply
        .code(403)
        .send(apiError('forged-authority', 'Сеанс модели не держит видеокарту'));
    const local = port();
    if (!local) return reply.code(501).send(notImplemented);
    return local.hold.release();
  });
}

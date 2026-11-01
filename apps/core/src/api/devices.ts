import type { FastifyInstance } from 'fastify';
import {
  adoptDevicesBodySchema,
  type AdoptDevicesReply,
} from '@agentdeck/contracts/core/panel-api';
import { deviceIdOf } from '@agentdeck/contracts/phone-signing';
import { decideAuthority } from '../policy/authority/authority.ts';
import { publicKeyHash, type SigningDevice } from '../policy/authority/device-signature.ts';
import { proofOfBody } from './body-proof.ts';
import { apiError, commandStatus } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * `POST /v1/devices/adopt` — перенос привязанных ключей телефона в устройства ядра (G9, F11).
 * Машинная ручка, не команда задачи: класс `adopt-devices` — `human-strict` (число страницы и
 * чистый пир, либо подпись уже известного ядру устройства). Модель, добавившая свой ключ,
 * подписывала бы «человека» сама — поэтому токен сессии и процесс из её дерева получают отказ
 * суда, а номер каждого устройства обязан быть выведен из его ключа (`deviceIdOf`).
 *
 * Форма тела — контракт панели (`adoptDevicesBodySchema`, строгая): прокладка пересылает её как есть.
 */

export const ADOPT_DEVICES_ROUTE = 'POST /v1/devices/adopt';

/** Запись списка и журнал ядра (`devices.adopted` / `devices.refused`) — у загрузки. */
export interface DevicesPort {
  adopt(devices: readonly SigningDevice[], meta: { cmdId: string; by: string }): { digest: string };
  refused(cmdId: string, code: string): void;
}

export function registerDevices(
  app: FastifyInstance,
  ctx: RouteContext,
  port: () => DevicesPort | undefined,
): void {
  app.post('/v1/devices/adopt', async (request, reply) => {
    const token = ctx.tokenOf(request);
    if (token === 'none') {
      return reply.code(401).send(apiError('token-required', 'Нужен токен ядра'));
    }
    const devices = port();
    if (!devices) {
      return reply.code(501).send(apiError('not-implemented', 'Устройства ядра не подключены'));
    }
    const parsed = adoptDevicesBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        apiError('bad-devices', 'Список устройств не прошёл разбор', {
          issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        }),
      );
    }
    const body = parsed.data;
    // Номер — из ключа, а не со слов присылающего: чужой номер под своим ключом подменил бы
    // отзыв и запись «последнего использования» другого телефона.
    const forged = body.devices.find(
      (device) => deviceIdOf(publicKeyHash(device.publicKey) ?? '') !== device.id,
    );
    if (forged) {
      return reply
        .code(422)
        .send(apiError('device-id-mismatch', `Номер ${forged.id} не выведен из ключа устройства`));
    }
    const authority = decideAuthority(
      'adopt-devices',
      await proofOfBody(request.raw, ADOPT_DEVICES_ROUTE, body, token, ctx.proof),
    );
    if (!authority.allow) {
      devices.refused(body.cmdId, authority.code);
      return reply
        .code(commandStatus(authority.code))
        .send(apiError(authority.code, authority.reason));
    }
    const list: SigningDevice[] = body.devices.map((device) => ({
      id: device.id,
      publicKey: device.publicKey,
      ...(device.revokedAt ? { revokedAt: device.revokedAt } : {}),
    }));
    const { digest } = devices.adopt(list, { cmdId: body.cmdId, by: authority.by });
    const out: AdoptDevicesReply = {
      cmdId: body.cmdId,
      adopted: list.map((device) => device.id),
      digest,
    };
    return out;
  });
}

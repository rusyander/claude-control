import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  SIGNATURE_HEADER,
  devicesSetText,
  deviceIdOf,
  formatFingerprint,
  type PhoneSigningView,
} from '@agentdeck/contracts/phone-signing';
import { activeDevices, type PhoneSigningStore } from '../../domains/phone-signing/store.ts';
import type { StoredSigningDevice } from '../../domains/phone-signing/phone-signing.types.ts';
import { publicKeyHash, sha256Hex, verifySignature } from '../../domains/phone-signing/verify.ts';
import { machineId } from '../../lib/machine-identity/machine-identity.ts';
import { acceptSignature } from './phone-signing-gate.ts';
import { phoneSigningPath, phoneSigningStore, refuseSignature } from './signing-common.ts';

/**
 * Режим «решения только с подписью телефона»: привязка ключа, отзыв, включение.
 *
 * Привязка — только при ВЫКЛЮЧЕННОМ режиме и с подписью самим привязываемым
 * ключом (телефон доказывает, что закрытый ключ у него). Включить и выключить
 * режим можно только подписью привязанного телефона: окно панели показывает
 * состояние и отзывает ключи, но решать за телефон не может — правка
 * фронтенда исполняется в том же окне. Отзыв свободен: он только ужесточает.
 */

export interface PhoneSigningRouteDeps {
  store?: () => PhoneSigningStore;
  machineId?: () => string;
  now?: () => number;
  storePath?: () => string;
}

function viewOf(store: PhoneSigningStore, panel: string, path: string): PhoneSigningView {
  const state = store.read();
  return {
    enabled: state.enabled,
    ...(state.enabledAt ? { enabledAt: state.enabledAt } : {}),
    machineId: panel,
    storePath: path,
    devices: state.devices.map((device) => ({
      ...device,
      fingerprint: formatFingerprint(publicKeyHash(device.publicKey) ?? ''),
    })),
  };
}

const invalidBody = (reply: FastifyReply) =>
  reply.code(400).send({
    code: 'phone_signing_body_invalid',
    message: 'Запрос режима подписи описан неверно.',
    messageCode: 'phone-signing-body-invalid',
  });

export function registerPhoneSigningRoutes(
  app: FastifyInstance,
  _ctx?: unknown,
  deps: PhoneSigningRouteDeps = {},
): void {
  const store = deps.store ?? (() => phoneSigningStore());
  const panel = deps.machineId ?? (() => machineId());
  const now = deps.now ?? Date.now;
  const path = deps.storePath ?? phoneSigningPath;
  const view = () => viewOf(store(), panel(), path());

  app.get('/api/phone-signing', () => view());

  app.post<{ Body: unknown }>('/api/phone-signing/devices', async (request, reply) => {
    const body = request.body as { label?: unknown; publicKey?: unknown } | null;
    const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 80) : '';
    const publicKey = typeof body?.publicKey === 'string' ? body.publicKey : '';
    const hash = publicKeyHash(publicKey);
    if (!hash) return invalidBody(reply);
    const at = now();
    const outcome = verifySignature(
      {
        route: 'POST /api/phone-signing/devices',
        params: {},
        body: request.body,
        header: request.headers[SIGNATURE_HEADER],
      },
      { machineId: panel(), now: at, devices: [], bindKey: publicKey },
    );
    if (!outcome.ok) return refuseSignature(reply, outcome.refusal);
    const device: StoredSigningDevice = {
      id: deviceIdOf(hash),
      label,
      publicKey,
      boundAt: new Date(at).toISOString(),
    };
    const result = store().bind(device);
    if (result === 'enabled') {
      return reply.code(409).send({
        code: 'phone_signing_enabled',
        message:
          'Новый ключ не привязан: режим подписи включён. Выключите его на уже привязанном телефоне, привяжите новый и включите снова.',
        messageCode: 'phone-signing-enabled',
      });
    }
    if (result === 'revoked') {
      return reply.code(409).send({
        code: 'phone_signing_key_revoked',
        message:
          'Ключ не привязан: он отозван в панели. Телефон создаст новый ключ — привяжите его.',
        messageCode: 'phone-signing-key-revoked',
      });
    }
    if (!store().consumeNonce(outcome.deviceId, outcome.nonce, at)) {
      return refuseSignature(reply, 'replayed');
    }
    return view();
  });

  app.post<{ Params: { id: string } }>(
    '/api/phone-signing/devices/:id/revoke',
    async (request, reply) => {
      if (!store().revoke(request.params.id, new Date(now()))) {
        return reply.code(404).send({
          code: 'phone_signing_device_not_found',
          message: 'Такого ключа нет среди привязанных.',
          messageCode: 'phone-signing-device-not-found',
        });
      }
      return view();
    },
  );

  app.post<{ Body: unknown }>('/api/phone-signing/mode', async (request, reply) => {
    const body = request.body as { enabled?: unknown; devicesHash?: unknown } | null;
    if (typeof body?.enabled !== 'boolean') return invalidBody(reply);
    const current = store().read();
    // Подпись проверяется и при выключенном режиме: включает его только телефон.
    const signed = acceptSignature(
      request,
      { store, machineId: panel, now },
      'POST /api/phone-signing/mode',
      current,
    );
    if (!signed.ok) return refuseSignature(reply, signed.refusal, store().path);
    // Включение сверяет набор, который ПОКАЗАЛ телефон, с набором здесь: ключ,
    // добавленный между экраном телефона и нажатием, включение остановит.
    const devices = activeDevices(current);
    if (body.enabled && body.devicesHash !== sha256Hex(devicesSetText(devices))) {
      return reply.code(409).send({
        code: 'phone_signing_devices_changed',
        message:
          'Режим не включён: список привязанных телефонов изменился. Обновите экран и сверьте отпечатки ещё раз.',
        messageCode: 'phone-signing-devices-changed',
      });
    }
    store().setMode(body.enabled, signed.deviceId, new Date(now()));
    return view();
  });
}

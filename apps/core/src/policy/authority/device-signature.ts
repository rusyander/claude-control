import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  SIGNATURE_MAX_SKEW_MS,
  buildSignedMessage,
  deviceIdOf,
  fromBase64Url,
  parseSignatureHeader,
  signedPayloadText,
  utf8Bytes,
  type SignatureRefusal,
} from '@agentdeck/contracts/phone-signing';

/**
 * Подпись решения ключом устройства (06 §Authority (b), P97). Перенос
 * `apps/server/src/domains/phone-signing/verify.ts` в ядро: ядро — отдельный процесс и не
 * импортирует панель, поэтому проверка своя; формат подписи общий (контракт `phone-signing`).
 * Серверная копия остаётся, пока подписью пользуется панель (долг миграции, 10).
 *
 * Чистая функция: ни файлов, ни часов. Порядок: подпись → отзыв → часы. Посторонний с кривой
 * подписью узнаёт только «не принята»; «отозван» и «просрочено» слышит лишь держатель ключа.
 * Одноразовость номера подписи — у вызывающего (`authority.ts`), здесь только проверка.
 */

export interface SigningDevice {
  id: string;
  publicKey: string;
  revokedAt?: string;
}

export interface DeviceSignatureInput {
  route: string;
  params: Record<string, string>;
  body: unknown;
  header: unknown;
}

export interface DeviceSignatureContext {
  machineId: string;
  now: number;
  devices: readonly SigningDevice[];
}

export type DeviceSignatureOutcome =
  { ok: true; deviceId: string; nonce: string } | { ok: false; refusal: SignatureRefusal };

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof data === 'string' ? utf8Bytes(data) : data)
    .digest('hex');
}

export function publicKeyHash(publicKey: string): string | undefined {
  const raw = fromBase64Url(publicKey);
  return raw && raw.length === 32 ? sha256Hex(raw) : undefined;
}

export function verifyEd25519(publicKey: string, message: string, signature: string): boolean {
  const raw = fromBase64Url(publicKey);
  const sig = fromBase64Url(signature);
  if (!raw || raw.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKey },
      format: 'jwk',
    });
    return verify(null, utf8Bytes(message), key, sig);
  } catch {
    // Кривой ключ или подпись — «не сошлось», а не авария: решает отказ, не исключение.
    return false;
  }
}

export function verifyDeviceSignature(
  input: DeviceSignatureInput,
  context: DeviceSignatureContext,
): DeviceSignatureOutcome {
  if (input.header === undefined || input.header === '') return { ok: false, refusal: 'required' };
  const header = parseSignatureHeader(input.header);
  if (!header) return { ok: false, refusal: 'invalid' };
  const device = context.devices.find((item) => item.id === header.device);
  if (!device) return { ok: false, refusal: 'invalid' };
  const hash = publicKeyHash(device.publicKey);
  if (!hash || deviceIdOf(hash) !== device.id) return { ok: false, refusal: 'invalid' };
  const message = buildSignedMessage({
    panel: context.machineId,
    device: header.device,
    route: input.route,
    payloadHash: sha256Hex(signedPayloadText(input.params, input.body)),
    nonce: header.nonce,
    time: header.time,
  });
  if (!verifyEd25519(device.publicKey, message, header.sig)) {
    return { ok: false, refusal: 'invalid' };
  }
  if (device.revokedAt) return { ok: false, refusal: 'revoked' };
  if (Math.abs(context.now - header.time) > SIGNATURE_MAX_SKEW_MS) {
    return { ok: false, refusal: 'stale' };
  }
  return { ok: true, deviceId: header.device, nonce: header.nonce };
}

import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  SIGNATURE_MAX_SKEW_MS,
  buildSignedMessage,
  deviceIdOf,
  fromBase64Url,
  parseSignatureHeader,
  signedPayloadText,
  utf8Bytes,
} from '@agentdeck/contracts/phone-signing';
import type { SignatureInput, VerifyContext, VerifyOutcome } from './phone-signing.types.ts';

/**
 * Проверка подписи решения. Чистая: ни файлов, ни часов — состояние, номер
 * машины и «сейчас» приходят аргументами, поэтому каждую ветку отказа тест
 * проходит настоящей криптографией, без подмен.
 *
 * Порядок важен: сперва подпись, потом отзыв, часы и одноразовость. Отказ
 * «ключ отозван» или «просрочено» говорит только тому, кто держит настоящий
 * ключ, — посторонний с кривой подписью узнаёт лишь «подпись не принята».
 */

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof data === 'string' ? utf8Bytes(data) : data)
    .digest('hex');
}

/** sha256 сырых байт открытого ключа; кривой ключ — `undefined`. */
export function publicKeyHash(publicKey: string): string | undefined {
  const raw = fromBase64Url(publicKey);
  return raw && raw.length === 32 ? sha256Hex(raw) : undefined;
}

/** Ed25519 через `node:crypto`; любая ошибка формы ключа или подписи — «не сошлось». */
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
    return false;
  }
}

export function verifySignature(input: SignatureInput, context: VerifyContext): VerifyOutcome {
  if (input.header === undefined || input.header === '') {
    return { ok: false, refusal: 'required' };
  }
  const header = parseSignatureHeader(input.header);
  if (!header) return { ok: false, refusal: 'invalid' };

  let publicKey: string;
  let revoked = false;
  if (context.bindKey !== undefined) {
    const hash = publicKeyHash(context.bindKey);
    if (!hash || deviceIdOf(hash) !== header.device) return { ok: false, refusal: 'invalid' };
    publicKey = context.bindKey;
  } else {
    const device = context.devices.find((item) => item.id === header.device);
    if (!device) return { ok: false, refusal: 'invalid' };
    publicKey = device.publicKey;
    revoked = Boolean(device.revokedAt);
  }

  const message = buildSignedMessage({
    panel: context.machineId,
    device: header.device,
    route: input.route,
    payloadHash: sha256Hex(signedPayloadText(input.params, input.body)),
    nonce: header.nonce,
    time: header.time,
  });
  if (!verifyEd25519(publicKey, message, header.sig)) return { ok: false, refusal: 'invalid' };
  if (revoked) return { ok: false, refusal: 'revoked' };
  if (Math.abs(context.now - header.time) > SIGNATURE_MAX_SKEW_MS) {
    return { ok: false, refusal: 'stale' };
  }
  return { ok: true, deviceId: header.device, nonce: header.nonce };
}

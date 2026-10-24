import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  buildSignedMessage,
  deviceIdOf,
  devicesSetText,
  formatFingerprint,
  formatSignatureHeader,
  fromBase64Url,
  matchSignedRoute,
  signatureClass,
  signedPayloadText,
  toBase64Url,
  utf8Bytes,
  type SignedRouteMatch,
} from '@agentdeck/contracts/phone-signing';

/**
 * Подпись решений ключом этого телефона — чистая часть, без хранилища и сети.
 *
 * Ed25519 на чистом JS (`@noble/curves`): у Hermes нет `crypto.subtle`, а у
 * `expo-crypto` нет подписи. Зерно ключа (32 байта) приходит снаружи — из
 * SecureStore (`keyStore.ts`); подпись детерминирована и случайности не просит.
 * Текст подписи строит общий модуль контрактов — тот же, по которому сервер
 * проверяет (`apps/server/src/domains/phone-signing/verify.ts`).
 */

export interface PhoneKey {
  seed: Uint8Array;
  /** Открытый ключ, 32 байта base64url — то, что уходит в панель при привязке. */
  publicKey: string;
  /** Номер устройства — из ключа, как у сервера. */
  deviceId: string;
  /** Отпечаток для глаз — его сверяют с окном панели. */
  fingerprint: string;
}

export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(typeof data === 'string' ? utf8Bytes(data) : data));
}

export function keyFromSeed(seed: Uint8Array): PhoneKey {
  const publicBytes = ed25519.getPublicKey(seed);
  const hash = sha256Hex(publicBytes);
  return {
    seed,
    publicKey: toBase64Url(publicBytes),
    deviceId: deviceIdOf(hash),
    fingerprint: formatFingerprint(hash),
  };
}

/** Отпечаток чужого открытого ключа (список привязанных) — тем же правилом. */
export function fingerprintOf(publicKey: string): string {
  const raw = fromBase64Url(publicKey);
  return raw ? formatFingerprint(sha256Hex(raw)) : '';
}

/**
 * Какой маршрут решения стоит за запросом и нужна ли ему подпись. `path` —
 * как у клиента, без `/api` (`/chat/deferred/D-7/decision`).
 */
export function signingTarget(
  method: string,
  path: string,
  body: unknown,
): SignedRouteMatch | undefined {
  const match = matchSignedRoute(method, `/api${path}`);
  if (!match) return undefined;
  return signatureClass(match.route, body) === 'signed' ? match : undefined;
}

export interface SignInput {
  key: PhoneKey;
  /** Номер машины панели — подпись для другого компьютера там не подойдёт. */
  panel: string;
  target: SignedRouteMatch;
  /** Тело так, как его разберёт сервер (`JSON.parse(JSON.stringify(...))`). */
  body: unknown;
  nonce: string;
  time: number;
}

/** Заголовок `x-agentdeck-signature` для одного запроса. */
export function signatureHeader(input: SignInput): string {
  const message = buildSignedMessage({
    panel: input.panel,
    device: input.key.deviceId,
    route: input.target.route,
    payloadHash: sha256Hex(signedPayloadText(input.target.params, input.body)),
    nonce: input.nonce,
    time: input.time,
  });
  const sig = toBase64Url(ed25519.sign(utf8Bytes(message), input.key.seed));
  return formatSignatureHeader({
    device: input.key.deviceId,
    nonce: input.nonce,
    time: input.time,
    sig,
  });
}

/**
 * Хэш набора живых устройств, который ПОКАЗАН человеку перед включением:
 * сервер сверит его со своим и не включит режим, если между экраном и
 * нажатием кто-то добавил ключ.
 */
export function devicesHashOf(
  devices: readonly { id: string; publicKey: string; revokedAt?: string }[],
): string {
  return sha256Hex(devicesSetText(devices.filter((device) => !device.revokedAt)));
}

/** Тело в том виде, в каком его увидит сервер после разбора JSON. */
export function wireBody(body: unknown): unknown {
  return body === undefined ? undefined : (JSON.parse(JSON.stringify(body)) as unknown);
}

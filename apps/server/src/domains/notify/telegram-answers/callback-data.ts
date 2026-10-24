import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Подпись кнопок: `t:<сообщение>:<действие>:<подпись>`.
 *
 * Telegram отдаёт `callback_data` обратно как есть, но собрать нажатие может
 * любой, кто пишет боту, — поэтому кнопка несёт подпись HMAC по ключу, который
 * живёт только на этой машине, и соли самого сообщения. Подделанное или чужое
 * нажатие подписи не сойдётся. Одноразовость держит запись сообщения:
 * отвеченное ожидание второй раз не решается, повтор получает «уже отвечено».
 *
 * Предел Telegram — 64 байта; здесь их около 30.
 */

const PREFIX = 't';
const MAC_LENGTH = 16;
export const CALLBACK_DATA_LIMIT = 64;

export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function newNonce(): string {
  return randomBytes(12).toString('base64url');
}

function mac(secret: string, sid: string, action: number, nonce: string): string {
  return createHmac('sha256', secret)
    .update(`${sid}|${action}|${nonce}`)
    .digest('base64url')
    .slice(0, MAC_LENGTH);
}

export function signCallback(secret: string, sid: string, action: number, nonce: string): string {
  const data = `${PREFIX}:${sid}:${action}:${mac(secret, sid, action, nonce)}`;
  if (Buffer.byteLength(data) > CALLBACK_DATA_LIMIT) {
    throw new Error('callback_data длиннее 64 байт');
  }
  return data;
}

/** Разобрать нажатие, не проверяя подписи: подпись сверяется с солью сообщения. */
export function parseCallback(
  data: string | undefined,
): { sid: string; action: number; mac: string } | undefined {
  const match = /^t:([0-9a-z]{1,10}):(\d{1,4}):([\w-]{16})$/.exec(data ?? '');
  if (!match) return undefined;
  return { sid: match[1]!, action: Number(match[2]), mac: match[3]! };
}

export function verifyCallback(
  secret: string,
  parsed: { sid: string; action: number; mac: string },
  nonce: string,
): boolean {
  const expected = Buffer.from(mac(secret, parsed.sid, parsed.action, nonce));
  const got = Buffer.from(parsed.mac);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

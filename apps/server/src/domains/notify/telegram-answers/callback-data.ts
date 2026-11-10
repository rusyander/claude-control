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
 *
 * Приставка (этап 12, D29): `t` — ожидания ответов, `n` — уведомления о задачах ядра. Подпись
 * не-`t` кнопки включает приставку: нажатие одного вида нельзя выдать за нажатие другого, даже
 * если номер сообщения и соль совпали. У `t` подпись прежняя — старые кнопки остаются живыми.
 */

const PREFIX = 't';
const PREFIX_SHAPE = /^[a-z]$/;
const MAC_LENGTH = 16;
export const CALLBACK_DATA_LIMIT = 64;

export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function newNonce(): string {
  return randomBytes(12).toString('base64url');
}

function checkedPrefix(prefix: string): string {
  if (!PREFIX_SHAPE.test(prefix)) throw new Error(`callback prefix is not one letter: ${prefix}`);
  return prefix;
}

function mac(secret: string, sid: string, action: number, nonce: string, prefix: string): string {
  const body = `${sid}|${action}|${nonce}`;
  return createHmac('sha256', secret)
    .update(prefix === PREFIX ? body : `${prefix}|${body}`)
    .digest('base64url')
    .slice(0, MAC_LENGTH);
}

export function signCallback(
  secret: string,
  sid: string,
  action: number,
  nonce: string,
  prefix: string = PREFIX,
): string {
  const head = checkedPrefix(prefix);
  const data = `${head}:${sid}:${action}:${mac(secret, sid, action, nonce, head)}`;
  if (Buffer.byteLength(data) > CALLBACK_DATA_LIMIT) {
    throw new Error('callback_data длиннее 64 байт');
  }
  return data;
}

/** Разобрать нажатие своей приставки, не проверяя подписи: подпись сверяется с солью сообщения. */
export function parseCallback(
  data: string | undefined,
  prefix: string = PREFIX,
): { sid: string; action: number; mac: string } | undefined {
  const head = checkedPrefix(prefix);
  const match = /^([a-z]):([0-9a-z]{1,10}):(\d{1,4}):([\w-]{16})$/.exec(data ?? '');
  if (!match || match[1] !== head) return undefined;
  return { sid: match[2]!, action: Number(match[3]), mac: match[4]! };
}

export function verifyCallback(
  secret: string,
  parsed: { sid: string; action: number; mac: string },
  nonce: string,
  prefix: string = PREFIX,
): boolean {
  const expected = Buffer.from(
    mac(secret, parsed.sid, parsed.action, nonce, checkedPrefix(prefix)),
  );
  const got = Buffer.from(parsed.mac);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

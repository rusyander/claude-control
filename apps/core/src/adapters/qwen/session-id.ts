import { createHash } from 'node:crypto';

/**
 * Id разговора Qwen Code из id сеанса ядра (03 §CLI adapter). CLI берёт `--session-id` только
 * UUID версий 1–5 (0.24.3, `CALLER_SUPPLIED_SESSION_ID_REGEX`: третья группа с `[1-5]`, вариант
 * `[89ab]`), иначе выходит с кодом 1 «Invalid --session-id». Ядро же даёт UUIDv7. Поэтому id
 * разговора — UUID v5 от id ядра в постоянном пространстве имён: чистая функция, без записи
 * соответствия. После перезапуска ядра тот же id сеанса из журнала (`session.started.sessionId`,
 * `resumeOf`; и сам флаг — в `argv` той же строки) даёт тот же разговор CLI.
 */

/** Что CLI принимает как id сеанса (`--session-id`, `--resume`). */
const CLI_ACCEPTS = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Любой UUID — форма id сеанса ядра. */
const ANY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Пространство имён v5 для id сеансов ядра. НЕ МЕНЯТЬ: смена отрывает каждый прежний сеанс от
 * его разговора (возобновление найдёт пустоту).
 */
export const SESSION_NAMESPACE = '5f0c3a2e-8b41-4d6a-9e27-c1d84b7f3a90';

/** UUID v5 (RFC 9562 §5.5): SHA-1 от байтов пространства имён и имени, версия 5, вариант 10. */
export function uuidV5(namespace: string, name: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Id сеанса ядра → id разговора CLI. Уже принимаемый CLI — как есть (разговор, названный самим
 * CLI); другой UUID (v7 ядра) — его v5; не UUID — `null`: флаг не выразить.
 */
export function qwenSessionId(id: string): string | null {
  if (CLI_ACCEPTS.test(id)) return id;
  if (!ANY_UUID.test(id)) return null;
  return uuidV5(SESSION_NAMESPACE, id.toLowerCase());
}

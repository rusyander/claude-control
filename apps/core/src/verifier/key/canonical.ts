import { createHash, createHmac } from 'node:crypto';

/**
 * Каноническая форма JSON (ключи по порядку, без пробелов): ключ проверки и подпись записи
 * считаются по ней — один и тот же объект, собранный в другом порядке полей, даёт тот же хеш.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortDeep(v)]));
  }
  return value;
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmac(key: Uint8Array, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

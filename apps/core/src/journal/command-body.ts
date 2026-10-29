import { createHash } from 'node:crypto';
import { maskData } from './line.ts';
import type { MaskFn } from './journal.types.ts';

/**
 * Отпечаток тела команды (01 §Commands): повтор `cmdId` — повтор ТОЙ ЖЕ команды. Свёртка хранит
 * отпечаток принятого тела, приём сравнивает с ним тело повтора; другое тело под тем же `cmdId`
 * не исполняется ни по доказательству первого, ни как сохранённый исход (ревью M1, 28.10).
 * Ключи объектов сортируются: тот же JSON в другом порядке ключей — то же тело.
 */
export interface CommandBody {
  kind: string;
  target: unknown;
  expectSeq: number | null;
  fields: unknown;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

export function commandBodyHash(body: CommandBody): string {
  const text = JSON.stringify(
    canonical({
      kind: body.kind,
      target: body.target,
      expectSeq: body.expectSeq,
      fields: body.fields,
    }),
  );
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Отпечаток тела так, как его видит журнал: после маски DLP писателя (ревью core-s2 F-25).
 * Свёртка считает отпечаток по маскированной строке; повтор с секретом сравнивается с ним
 * только через ту же маску — иначе тот же самый повтор выглядел «другим телом». Сырой
 * отпечаток секрета в журнал не пишется: он — оракул для перебора слабого секрета.
 */
export function maskedCommandBodyHash(body: CommandBody, mask: MaskFn): string {
  return commandBodyHash(maskData(body, mask).data as CommandBody);
}

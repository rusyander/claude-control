import { createHash } from 'node:crypto';
import { dataSchemaFor, JOURNAL_VERSION } from '@agentdeck/contracts/core/journal';
import type { MaskFn } from './journal.types.ts';

/**
 * Строка журнала: цепочка хешей и маска секретов (01 §Journal).
 *
 * Цепочка `h_n = sha256(h_{n-1} ‖ "\n" ‖ line_n)` идёт по байтам строки, как она лежит на диске
 * (до апкаста), начало — `sha256("agentdeck-journal:" + taskId)`. Снимок хранит `h` своей
 * строки: снимок, чей `h` не совпал с цепочкой, не используется — полная перемотка (R:S3-06).
 */

export function genesisHash(taskId: string): string {
  return createHash('sha256').update(`agentdeck-journal:${taskId}`).digest('hex');
}

export function chainHash(previous: string, lineText: string): string {
  return createHash('sha256').update(previous).update('\n').update(lineText).digest('hex');
}

export function sha256OfText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Маска по всем строкам данных (ключи объекта — имена полей схемы, их не трогаем). */
export function maskData(data: unknown, mask: MaskFn): { data: unknown; count: number } {
  let count = 0;
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const masked = mask(value);
      count += masked.count;
      return masked.text;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]),
      );
    }
    return value;
  };
  return { data: walk(data), count };
}

/** Данные вида по строгой схеме версии; ответ — список проблем (пусто — годится). */
export function validateData(kind: string, data: unknown, v: number = JOURNAL_VERSION): string[] {
  const schema = dataSchemaFor(v, kind);
  if (!schema) return [`unknown kind ${kind} in v${v}`];
  const parsed = schema.safeParse(data);
  if (parsed.success) return [];
  return parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || '(data)'}: ${issue.message}`,
  );
}

import { createHash } from 'node:crypto';

/**
 * Отпечаток вызова для разрешения D-n: имя инструмента + ВЕСЬ вход в
 * каноническом JSON (ключи по алфавиту на любой глубине).
 *
 * Пробелы НЕ схлопываются и голова команды не выделяется: разрешено ровно то,
 * что человек видел. «Похожая» команда (`rm -rf ./a` против `rm -rf ./a ./b`,
 * лишний ключ, другой путь) — другой отпечаток, и разрешения у неё нет.
 *
 * Выбрасываются только поля, которые не меняют действия, а модель их пишет
 * каждый раз по-новому: `description` у любого инструмента (подпись для
 * человека), у `Bash` — ещё `timeout` и `run_in_background` (как долго ждать и
 * ждать ли, но не что делать). Без этого повтор ровно той же команды с другой
 * подписью не совпал бы, и разрешение человека не сработало бы никогда.
 */
const COSMETIC_ANY = new Set(['description']);
const COSMETIC_BASH = new Set(['timeout', 'run_in_background']);

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/** Вход без косметических полей — только верхний уровень: глубже их смысл чужой. */
export function significantInput(toolName: string, input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (COSMETIC_ANY.has(key)) continue;
    if (toolName === 'Bash' && COSMETIC_BASH.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export function callHash(toolName: string, input: unknown): string {
  return createHash('sha256')
    .update(`${toolName}\n${canonicalJson(significantInput(toolName, input))}`)
    .digest('hex');
}

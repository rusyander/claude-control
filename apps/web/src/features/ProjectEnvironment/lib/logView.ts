import type { LogEntry } from '@entities/Logs';
import { parseLogLine, passesLevel, type LogLevel, type ParsedLog } from './logParse';

export interface LogRow {
  entry: LogEntry;
  parsed: ParsedLog;
}

/**
 * Разбор держится на самой строке: опрос раз в секунду добавляет строки в
 * конец, и разбирать заново все 5000 на каждый ответ незачем. Ключ — объект
 * строки: новый источник — новые объекты, кеш уходит вместе со старыми.
 */
const cache = new WeakMap<LogEntry, ParsedLog>();

export function parseEntries(entries: LogEntry[]): LogRow[] {
  let previous: LogLevel | undefined;
  return entries.map((entry) => {
    let parsed = cache.get(entry);
    if (!parsed) {
      parsed = parseLogLine(entry.text, previous);
      cache.set(entry, parsed);
    }
    previous = parsed.level;
    return { entry, parsed };
  });
}

export interface LogFilter {
  search: string;
  level?: LogLevel;
}

/** Строки, прошедшие поиск (без учёта регистра, по тексту и полям JSON) и порог уровня. */
export function filterRows(rows: LogRow[], filter: LogFilter): LogRow[] {
  const needle = filter.search.trim().toLowerCase();
  if (!needle && !filter.level) return rows;
  return rows.filter(
    (row) =>
      passesLevel(row.parsed.level, filter.level) &&
      (!needle || row.entry.text.toLowerCase().includes(needle)),
  );
}

/** Сколько строк каждого уровня — подписи к кнопкам фильтра. */
export function countLevels(rows: LogRow[]): Record<LogLevel, number> {
  const counts: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, debug: 0 };
  for (const row of rows) if (row.parsed.level) counts[row.parsed.level] += 1;
  return counts;
}

/** Куски текста для подсветки совпадений: нечётные — совпадения. */
export function splitMatches(text: string, search: string): string[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return [text];
  const parts: string[] = [];
  const lower = text.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    parts.push(text.slice(from, at), text.slice(at, at + needle.length));
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return parts;
}

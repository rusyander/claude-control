import { statSync } from 'node:fs';
import { sessionTime, unionMs } from '../../analytics/token-audit/time.ts';
import { readWholeTranscriptRecords } from '../ChatHistory/ChatHistory.ts';

/**
 * Сколько разговор РАБОТАЛ: модель писала ответ или шёл инструмент (объединение
 * отрезков, `sessionTime`). Карточка группы считала «время работы» от заведения
 * звена до его последней записи — пауза на двое суток, ожидание лимита и простой
 * между ходами шли туда же (владелец, 19.10.2026: 52 ч у группы, работавшей ~4 ч).
 *
 * Разбор — весь транскрипт, поэтому кеш по пути: тот же размер и время файла —
 * готовое число; файл растёт (идёт прогон) — пересчёт не чаще раза в
 * `REFRESH_MS`, длительности в карточке хватает такой свежести, а список
 * перечитывается на каждое событие наблюдателя.
 */
const REFRESH_MS = 30_000;

interface Entry {
  size: number;
  mtimeMs: number;
  computedAt: number;
  activeMs: number | undefined;
}

const cache = new Map<string, Entry>();

export function chatActiveMs(path: string, now: number = Date.now()): number | undefined {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return undefined;
  }
  const cached = cache.get(path);
  if (cached) {
    const same = cached.size === stats.size && cached.mtimeMs === stats.mtimeMs;
    if (same || now - cached.computedAt < REFRESH_MS) return cached.activeMs;
  }
  const time = sessionTime(readWholeTranscriptRecords(path) as Record<string, unknown>[]);
  const activeMs = time ? unionMs(time.busy) : undefined;
  cache.set(path, { size: stats.size, mtimeMs: stats.mtimeMs, computedAt: now, activeMs });
  return activeMs;
}

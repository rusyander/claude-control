import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { CACHE_TTL_LONG_MS, CACHE_TTL_SHORT_MS, contextOf } from './cost.ts';

/**
 * Факты сессии для правила продолжения и прогрева — из строк `turn.usage` журнала задачи: стена
 * последнего хода (возраст кэша), размер его запроса и срок кэша. Срок — по последнему ходу,
 * который писал кэш: доля часовой записи есть — час, нет — пять минут; сессия, кэш не писавшая,
 * берёт факт маршрута (`null` — маршрут без кэша). Строки подагентов и остатков не в счёт: они
 * не запрос этой сессии.
 */

export interface SessionCacheFacts {
  lastTurnAt: number | null;
  contextTokens: number;
  cacheTtlMs: number | null;
  /** Ходов сессии (без остатков и подагентов). */
  turns: number;
}

export function sessionCacheFacts(
  lines: readonly JournalLine[],
  sessionId: string,
  routeTtlMs: number | null = null,
): SessionCacheFacts {
  let last: { at: number; ctx: number } | null = null;
  let ttl: number | null = null;
  let read = false;
  // Повтор строки по messageId заменяет прежнюю (сборка хода по частям): считаем ходы по id.
  const ids = new Set<string>();
  for (const l of lines) {
    if (l.kind !== 'turn.usage') continue;
    const d = (l as JournalLine<'turn.usage'>).data;
    if (d.sessionId !== sessionId || d.subagent || d.remainder) continue;
    ids.add(d.messageId);
    last = { at: l.at, ctx: contextOf(d) };
    if (d.cacheWrite > 0) ttl = d.cacheWrite1h > 0 ? CACHE_TTL_LONG_MS : CACHE_TTL_SHORT_MS;
    if (d.cacheRead > 0) read = true;
  }
  return {
    lastTurnAt: last?.at ?? null,
    contextTokens: last?.ctx ?? 0,
    cacheTtlMs: ttl ?? routeTtlMs ?? (read ? CACHE_TTL_SHORT_MS : null),
    turns: ids.size,
  };
}

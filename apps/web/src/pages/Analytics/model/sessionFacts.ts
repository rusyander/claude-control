import type { TFunction } from 'i18next';
import type { SessionUsage } from '@agentdeck/contracts';
import { formatDuration } from '@shared/lib/format-duration';
import { formatNumber } from '@shared/lib/format-number';

/**
 * Длительность сессии: от первого до последнего учтённого ответа модели. Паузы
 * между репликами входят — транскрипт не пишет, когда человек отошёл, и «время
 * работы» из него не вычислить. Нечитаемая метка (старый или обрезанный
 * транскрипт) — `undefined`, а не ноль и не NaN на экране.
 */
export function sessionSpanMs(
  session: Pick<SessionUsage, 'startedAt' | 'lastActivity'>,
): number | undefined {
  const start = Date.parse(session.startedAt);
  const end = Date.parse(session.lastActivity);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
  return end - start;
}

/** Строка-сводка под именем сессии: длительность и число запросов к модели. */
export function sessionBrief(session: SessionUsage, t: TFunction, locale: string): string {
  const span = sessionSpanMs(session);
  const parts = [
    ...(span === undefined ? [] : [formatDuration(span, t)]),
    t('analytics.sessionRequests', { requests: formatNumber(session.totals.requests, locale) }),
  ];
  return parts.join(' · ');
}

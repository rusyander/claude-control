import type { SessionUsage } from '@agentdeck/contracts';
import type { TFunction } from 'i18next';
import { formatDuration } from '@shared/lib/format-duration';
import { sessionSpanMs } from './sessionFacts';
import { formatNumber } from '../../../shared/lib/formatNumber';

/** Строка-сводка под именем сессии: длительность и число запросов к модели. */
export function sessionBrief(session: SessionUsage, t: TFunction, locale: string): string {
  const span = sessionSpanMs(session);
  const parts = [
    ...(span === undefined ? [] : [formatDuration(span, t)]),
    t('analytics.sessionRequests', { requests: formatNumber(session.totals.requests, locale) }),
  ];
  return parts.join(' · ');
}

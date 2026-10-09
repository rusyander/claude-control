import type { WatchReportSection } from '@entities/Watcher';
import type { BadgeTone } from '@shared/ui/badge';

/** Фильтры страницы отчёта: по виду записи и подтверждённые отдельно. */
export const REPORT_FILTERS = ['all', 'failure', 'remark', 'confirmed'] as const;
export type ReportFilter = (typeof REPORT_FILTERS)[number];

/** Попадает ли раздел в фильтр. «Подтверждённые» — то, что модель нашла в коде. */
export function matchesFilter(section: WatchReportSection, filter: ReportFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'confirmed') return section.verdict === 'confirmed';
  return section.entryClass === filter;
}

/** Тон серьёзности: критичное красным, низкое — без цвета, чтобы не кричать. */
export const SEVERITY_TONE: Record<WatchReportSection['severity'], BadgeTone> = {
  critical: 'danger',
  high: 'warning',
  medium: 'info',
  low: 'neutral',
};

/** Тон вердикта: подтверждённый — акцентом, «не в коде» — гаснет. */
export const VERDICT_TONE: Record<WatchReportSection['verdict'], BadgeTone> = {
  confirmed: 'accent',
  'not-in-code': 'neutral',
  unclear: 'warning',
  pending: 'info',
};

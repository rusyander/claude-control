import type { TFunction } from 'i18next';
import { formatDuration } from '@shared/lib/format-duration';

/**
 * Длительность прогона: незакрытый прогон длительности ещё не имеет. Единицы —
 * из словаря (`formatDuration`): английская запись показывала «15 с».
 */
export function formatRunDuration(
  startedAt: string,
  finishedAt: string | undefined,
  t: TFunction,
): string {
  if (!finishedAt) return '—';
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return formatDuration(ms, t);
}

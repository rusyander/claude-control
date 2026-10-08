import type { CommandRow } from '@entities/Command';

/** Тон бейджа источника: скилл и плагин выделяются, остальное нейтрально. */
export function sourceTone(row: CommandRow): 'neutral' | 'success' | 'info' {
  if (row.source === 'skill') return 'success';
  if (row.source === 'plugin') return 'info';
  return 'neutral';
}

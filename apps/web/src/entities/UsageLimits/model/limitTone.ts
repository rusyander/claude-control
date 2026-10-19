/** Тон окна: от трёх четвертей — предупреждение, от девяноста — опасность. */
export type LimitTone = 'normal' | 'warning' | 'danger';

export function limitTone(percent: number): LimitTone {
  if (percent >= 90) return 'danger';
  if (percent >= 75) return 'warning';
  return 'normal';
}

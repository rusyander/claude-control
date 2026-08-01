import type { FormatCheckState } from '@claude-control/contracts';

/** Цвет бейджа по состоянию. Отсутствие схемы — не тревога, а факт. */
export function stateTone(state: FormatCheckState): 'success' | 'warning' | 'neutral' {
  if (state === 'ok') return 'success';
  if (state === 'drift') return 'warning';
  return 'neutral';
}

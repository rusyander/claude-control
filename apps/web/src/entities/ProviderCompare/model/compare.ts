import type { BadgeTone } from '@shared/ui/badge';
import type { CompareState } from '@agentdeck/contracts';

/**
 * Чтение результата сравнения. Держим отдельно от разметки: «что тут можно
 * перенести» — правило, а не оформление, и его проверяют тестом.
 */

/** Цвет состояния записи. Совпадение — спокойное, разница — заметная. */
export function stateTone(state: CompareState): BadgeTone {
  switch (state) {
    case 'same':
      return 'success';
    case 'differs':
      return 'warning';
    default:
      return 'info';
  }
}

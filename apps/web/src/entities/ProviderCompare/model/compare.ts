import type { BadgeTone } from '@shared/ui/badge';
import type { CompareEntry, CompareSectionResult, CompareState } from '@claude-control/contracts';

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

/** Ключ подписи состояния — стороны называются по именам провайдеров в самой разметке. */
export function stateLabelKey(state: CompareState): string {
  return `providerCompare.state.${state}`;
}

/**
 * Что из раздела можно предложить к переносу в заданную сторону.
 *
 * Правило одно и оно узкое: раздел переносим, запись существует у ИСТОЧНИКА и не
 * помечена причиной отказа. Совпадающие записи из выбора не исключаем — перенос
 * поверх одинакового ничего не меняет, а лишний запрет только мешал бы.
 */
export function selectableKeys(
  section: CompareSectionResult,
  direction: 'left-to-right' | 'right-to-left',
): string[] {
  if (!section.migratable) return [];

  const hasSource = (entry: CompareEntry): boolean =>
    direction === 'left-to-right' ? entry.left !== undefined : entry.right !== undefined;

  return section.entries
    .filter((entry) => hasSource(entry) && !entry.blocked)
    .map((entry) => entry.key);
}

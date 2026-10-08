import type { CompareSectionResult, CompareEntry } from '@agentdeck/contracts';

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

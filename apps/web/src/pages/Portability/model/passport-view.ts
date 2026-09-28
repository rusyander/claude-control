import type { EnvItem, EnvNeeds } from '@agentdeck/contracts/portable-env';

/** Одинаковые требования — одинаковый ключ: набор фактов без учёта порядка, иначе фраза. */
function needsKey(needs: EnvNeeds): string {
  if (needs.resolution === 'facts') return `facts:${[...needs.facts].sort().join(',')}`;
  return `${needs.resolution}:${needs.why}`;
}

/**
 * Требование, общее для ВСЕХ записей вида, или `null`.
 *
 * У 51 скилла одна и та же строка «фактов рантайма ему не нужно»: повторённая
 * в каждой строке, она превращала вид в стену одинакового текста, за которой
 * терялась строка, отличающаяся от прочих. Общая показывается один раз над
 * списком — но только когда общая у всех: при одном несовпадении каждая строка
 * несёт свою, иначе отличие спряталось бы как раз там, где оно важно.
 */
export function sharedNeeds(items: readonly EnvItem[]): EnvNeeds | null {
  const [first, ...rest] = items;
  if (!first || rest.length === 0) return null;
  const key = needsKey(first.needs);
  return rest.every((item) => needsKey(item.needs) === key) ? first.needs : null;
}

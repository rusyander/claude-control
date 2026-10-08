import { fuzzyScore } from './fuzzy';

export interface RankedItem<T> {
  item: T;
  score: number;
}

/**
 * Отбирает и сортирует элементы по нечёткому совпадению их подписи с запросом.
 * `label` берётся из переданной функции — так модель не знает про i18n и
 * остаётся чистой и тестируемой. При равном балле сохраняется исходный порядок.
 */
export function rankByFuzzy<T>(
  items: readonly T[],
  query: string,
  getLabel: (item: T) => string,
): RankedItem<T>[] {
  const ranked: (RankedItem<T> & { order: number })[] = [];

  items.forEach((item, order) => {
    const score = fuzzyScore(getLabel(item), query);
    if (score !== null) ranked.push({ item, score, order });
  });

  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  return ranked.map(({ item, score }) => ({ item, score }));
}

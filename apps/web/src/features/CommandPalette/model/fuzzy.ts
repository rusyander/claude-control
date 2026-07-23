/**
 * Нечёткий поиск по названиям разделов для командной палитры. Запрос совпадает,
 * если его буквы встречаются в тексте по порядку (подпоследовательность). Балл
 * тем выше, чем короче путь совпадения, чем ближе к началу и чем больше букв
 * подряд, — так «настройки» всплывают выше «истории изменений» по запросу «наст».
 */

/**
 * Балл совпадения запроса с текстом или `null`, если совпадения нет. Сравнение
 * регистронезависимое; пустой запрос совпадает со всем (нейтральный балл 0).
 */
export function fuzzyScore(text: string, query: string): number | null {
  const haystack = text.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 0;

  let score = 0;
  let textIndex = 0;
  let previousMatch = -1;

  for (const char of needle) {
    const found = haystack.indexOf(char, textIndex);
    if (found === -1) return null;

    // Совпадение в начале слова ценнее, чем в середине.
    if (found === 0 || haystack[found - 1] === ' ') score += 8;
    // Буквы подряд — сильный сигнал: пользователь набирает начало слова.
    if (found === previousMatch + 1) score += 6;
    else score += 1;
    // Чем ближе к началу строки, тем лучше.
    score -= found * 0.1;

    previousMatch = found;
    textIndex = found + 1;
  }

  return score;
}

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

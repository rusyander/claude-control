/**
 * Сравнение значений по СМЫСЛУ, а не по тексту: ключи объектов сортируются
 * рекурсивно, порядок массивов сохраняется. Нужно сравнению провайдеров
 * (`domains/provider-compare.ts`) и кругу записи самопроверки
 * (`domains/provider-check.ts`) — там значения приходят из РАЗНЫХ адаптеров, и
 * порядок ключей у них свой.
 *
 * Не путать со `stableJson` из `lib/provider-json.ts`: тот сериализует и
 * `undefined` тоже и служит проекциям «всё, кроме управляемых панелью ключей»,
 * где исчезнувший ключ обязан быть виден.
 */
export function sortedJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return Object.fromEntries(entries.map(([key, item]) => [key, sortDeep(item)]));
}

/** Совпадает ли смысл значений «до» и «после». */
export function sameShape(before: unknown, after: unknown): boolean {
  return sortedJson(before) === sortedJson(after);
}

/** Строка подходит под фильтр: ищем в названии и описании без учёта регистра. */
export function matchesFilter(query: string, texts: readonly string[]): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return texts.some((text) => text.toLocaleLowerCase().includes(needle));
}

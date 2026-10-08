/** Первое значение списка фильтра — `select` показывает одно. */
export function first(list: readonly string[] | undefined): string {
  return list?.[0] ?? '';
}

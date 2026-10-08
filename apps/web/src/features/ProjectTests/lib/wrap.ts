/** Значение `select` обратно в список фильтра; пусто — поля в фильтре нет. */
export function wrap<T extends string>(value: string): T[] | undefined {
  return value ? [value as T] : undefined;
}

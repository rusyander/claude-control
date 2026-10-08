/** Стабильное представление черновика — им сравнивается «изменилось ли». */
export function stableDraft(value: unknown): string {
  return JSON.stringify(value);
}

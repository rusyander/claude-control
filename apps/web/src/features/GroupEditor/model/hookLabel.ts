/** Подпись хука: событие и фильтр — его id нечитаем. */
export const hookLabel = (item: { event: string; matcher?: string }): string =>
  `${item.event}${item.matcher ? ` · ${item.matcher}` : ''}`;

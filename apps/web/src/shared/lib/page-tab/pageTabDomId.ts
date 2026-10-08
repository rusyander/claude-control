/** Кнопка вкладки и её панель ссылаются друг на друга — id считаем в одном месте. */
export function pageTabDomId(page: string, tab: string): string {
  return `${page}-tab-${tab}`;
}

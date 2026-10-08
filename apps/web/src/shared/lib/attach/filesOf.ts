import type { TransferLike } from './transfer.types';

/**
 * Файлы из вставки или перетаскивания. `items` — основной источник: у вставки
 * снимка экрана `files` в части браузеров пуст, а файл лежит элементом вида
 * `file`. Нет `items` — берём `files`.
 */
export function filesOf(data: TransferLike | null | undefined): File[] {
  if (!data) return [];
  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  if (fromItems.length > 0) return fromItems;
  return Array.from(data.files ?? []);
}

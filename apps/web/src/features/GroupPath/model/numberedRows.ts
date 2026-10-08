import type { LayoutItem, NumberedRow } from './layout.types';

/** Все пронумерованные строки по порядку — для фильтра и подсчёта. */
export function numberedRows(layout: LayoutItem[]): NumberedRow[] {
  return layout.flatMap((item) => {
    if (item.kind === 'row') return [item.item];
    if (item.kind === 'block') return item.items;
    return [];
  });
}

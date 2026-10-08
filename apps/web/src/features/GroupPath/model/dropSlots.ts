import type { LayoutItem } from './layout.types';
import type { PathEntry } from '@agentdeck/contracts';
import { topSlot } from './topSlot';
import type { PathRow } from './pathRows.types';
import { canInsertAfter } from './canInsertAfter';

/**
 * Места, куда можно положить шаг, — те же, где стоит «+», по порядку экрана:
 * `afterIndex` для `moveToSlot`. Внутри свёрнутого блока мест нет — туда не
 * положить то, чего не видно. У сценария есть ещё место в самом начале.
 */
export function dropSlots(
  layout: LayoutItem[],
  rows: PathRow[],
  entries: PathEntry[],
  collapsed: ReadonlySet<string>,
): number[] {
  const slots: number[] = topSlot(entries) < 0 ? [-1] : [];
  const add = (index: number, row: PathRow): void => {
    if (canInsertAfter(rows, index)) slots.push(row.entryIndex);
  };
  for (const item of layout) {
    if (item.kind === 'stage') add(item.index, item.row);
    else if (item.kind === 'row') add(item.item.index, item.item.row);
    else {
      const isOpen = !collapsed.has(item.skillId);
      item.items.forEach((numbered, position) => {
        if (isOpen || position === item.items.length - 1) add(numbered.index, numbered.row);
      });
    }
  }
  return slots;
}

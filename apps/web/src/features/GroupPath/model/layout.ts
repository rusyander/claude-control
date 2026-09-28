import type { GroupFlow, PathAnchor } from '@agentdeck/contracts';
import { canInsertAfter, type PathRow } from './pathRows';
import { topSlot } from './pathEdit';
import type { PathEntry } from '@agentdeck/contracts';

/** Строка с номером: стадии не нумеруются — они разделители, а не шаги. */
export interface NumberedRow {
  row: PathRow;
  /** Номер шага с единицы. */
  number: number;
  /** Индекс строки в `rows` — по нему решается, есть ли «+» после неё. */
  index: number;
}

/**
 * Что рисует конструктор. У конвейера: стадия — тонкий разделитель, шаги
 * одного скилла (и свои шаги, вставленные внутрь него) — сворачиваемый блок,
 * остальное — отдельные строки. У сценария — только строки.
 */
export type LayoutItem =
  | { kind: 'stage'; stage: PathAnchor; row: PathRow; index: number }
  | { kind: 'row'; item: NumberedRow }
  | { kind: 'block'; skillId: string; items: NumberedRow[] };

function blockSkill(row: PathRow): string | undefined {
  if (row.kind !== 'entry') return undefined;
  const { entry } = row;
  if (entry.kind === 'skill-step') return entry.skillId;
  if (entry.kind === 'custom') return entry.step.within?.skillId;
  return undefined;
}

export function buildLayout(rows: PathRow[], flow: GroupFlow | undefined): LayoutItem[] {
  const items: LayoutItem[] = [];
  let number = 0;
  rows.forEach((row, index) => {
    if (row.kind === 'entry' && row.entry.kind === 'builtin') {
      items.push({ kind: 'stage', stage: row.entry.stage, row, index });
      return;
    }
    number += 1;
    const numbered = { row, number, index };
    const skillId = flow === 'scenario' ? undefined : blockSkill(row);
    const last = items.at(-1);
    if (skillId && last?.kind === 'block' && last.skillId === skillId) last.items.push(numbered);
    else if (skillId) items.push({ kind: 'block', skillId, items: [numbered] });
    else items.push({ kind: 'row', item: numbered });
  });
  return items;
}

/** Все пронумерованные строки по порядку — для фильтра и подсчёта. */
export function numberedRows(layout: LayoutItem[]): NumberedRow[] {
  return layout.flatMap((item) => {
    if (item.kind === 'row') return [item.item];
    if (item.kind === 'block') return item.items;
    return [];
  });
}

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

/** Строка подходит под фильтр: ищем в названии и описании без учёта регистра. */
export function matchesFilter(query: string, texts: readonly string[]): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return texts.some((text) => text.toLocaleLowerCase().includes(needle));
}

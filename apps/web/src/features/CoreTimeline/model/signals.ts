import type { RowItem, TimelineFold } from './fold.types';

export interface SignalRow {
  seq: number;
  signal: Extract<RowItem, { type: 'signal' }>;
}

/** Сигналы ленты новыми сверху — для панели сигналов и подсказок. */
export function signalRows(fold: TimelineFold): SignalRow[] {
  const out: SignalRow[] = [];
  for (const row of fold.rows) {
    if (row.item.type === 'signal') out.push({ seq: row.seq, signal: row.item });
  }
  return out.reverse();
}

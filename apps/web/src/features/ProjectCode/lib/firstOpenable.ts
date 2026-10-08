import type { ChangedRow } from './changedRows.types';

/** Первый файл, который можно открыть: удалённого на диске нет. */
export function firstOpenable(rows: ChangedRow[]): string | undefined {
  return rows.find((row) => !row.missing && row.status !== 'deleted')?.path;
}

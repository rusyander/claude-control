import { csvCell } from './report';

/** Строка CSV из ячеек с экранированием каждой. */
export function csvRow(cells: Array<string | number | boolean>): string {
  return cells.map(csvCell).join(',');
}

/** Собрать CSV из заголовка и строк данных (по-Windows перенос `\r\n`). */
export function toCsv(
  header: readonly string[],
  rows: Array<Array<string | number | boolean>>,
): string {
  return [csvRow([...header]), ...rows.map(csvRow)].join('\r\n');
}

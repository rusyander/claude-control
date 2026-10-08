/**
 * Чистые расчёты для тепловой шкалы. Вынесены из компонента, чтобы масштаб
 * насыщенности и раскладку ячеек можно было проверить тестами без рендера.
 */

/** Позиция ячейки в сетке по порядковому номеру и числу колонок. */
export function gridPosition(index: number, columns: number): { row: number; col: number } {
  const safeColumns = Math.max(1, columns);
  return { row: Math.floor(index / safeColumns), col: index % safeColumns };
}

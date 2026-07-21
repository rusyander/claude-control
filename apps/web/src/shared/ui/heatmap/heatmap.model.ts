/**
 * Чистые расчёты для тепловой шкалы. Вынесены из компонента, чтобы масштаб
 * насыщенности и раскладку ячеек можно было проверить тестами без рендера.
 */

/** Позиция ячейки в сетке по порядковому номеру и числу колонок. */
export function gridPosition(index: number, columns: number): { row: number; col: number } {
  const safeColumns = Math.max(1, columns);
  return { row: Math.floor(index / safeColumns), col: index % safeColumns };
}

/**
 * Насыщенность ячейки как доля от пика. Один тон, светлее→темнее — это
 * последовательная шкала: цвет кодирует величину, а не категорию. Ноль
 * возвращает 0 (пустая ячейка рисуется фоном-дорожкой), ненулевые значения
 * подтягиваются к видимому диапазону, чтобы «час с одним запросом» не сливался
 * с фоном, но и не спорил с пиком.
 */
export function cellIntensity(value: number, max: number): number {
  if (value <= 0) return 0;
  if (max <= 0) return 1;
  const ratio = Math.min(value / max, 1);
  return 0.15 + 0.85 * ratio;
}

/**
 * Шаг прореживания подписей оси: 24 часа целиком не помещаются, показываем
 * каждую N-ю. Всегда не меньше единицы, чтобы не делить на ноль.
 */
export function labelStep(count: number, maxLabels: number): number {
  if (count <= maxLabels) return 1;
  return Math.max(1, Math.ceil(count / maxLabels));
}

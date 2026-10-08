/**
 * Шаг прореживания подписей оси: 24 часа целиком не помещаются, показываем
 * каждую N-ю. Всегда не меньше единицы, чтобы не делить на ноль.
 */
export function labelStep(count: number, maxLabels: number): number {
  if (count <= maxLabels) return 1;
  return Math.max(1, Math.ceil(count / maxLabels));
}

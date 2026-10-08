/**
 * Где модель легла на деле — по ответу сервера (`/api/ps`), а не по выбору:
 * `gpuShare` — доля в видеопамяти, 0…1. Выбор «процессор» сервер может не
 * исполнить (Metal на Mac прятать нечем), и экран обязан это показать.
 */
export function placementOf(model: { vramBytes: number; sizeBytes: number }): {
  gpuShare: number;
} {
  if (model.sizeBytes <= 0) return { gpuShare: model.vramBytes > 0 ? 1 : 0 };
  return { gpuShare: Math.min(1, model.vramBytes / model.sizeBytes) };
}

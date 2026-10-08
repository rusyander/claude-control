/**
 * Адрес байтов картинки. Тот же и для показа, и для скачивания, и для телефона:
 * второй адрес означал бы второй маршрут и второе место, где он может разойтись
 * с первым.
 */
export function mediaImageUrl(id: string): string {
  return `/api/media/images/${encodeURIComponent(id)}`;
}

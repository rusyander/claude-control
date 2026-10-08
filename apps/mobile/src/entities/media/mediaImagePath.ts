/** Адрес байтов картинки — тот же, что у панели, для показа и скачивания. */
export function mediaImagePath(id: string): string {
  return `/media/images/${encodeURIComponent(id)}`;
}

/** Порт из отказа сервера: он кладёт его в тело ответа рядом с сообщением. */
export function busyPortOf(error: unknown): number | undefined {
  const data = (error as { response?: { data?: { busyPort?: unknown } } })?.response?.data;
  return typeof data?.busyPort === 'number' ? data.busyPort : undefined;
}

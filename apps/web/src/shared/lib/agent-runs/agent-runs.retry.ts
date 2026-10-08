/** Сколько авто-попыток уже потрачено на прогон (бюджет — `MAX_AUTO_RETRIES`). */
export const autoRetries = new Map<string, number>();

/**
 * Отложенные авто-рестарты и прогоны, остановленные человеком.
 *
 * Авто-рестарт живёт в `setTimeout` — то есть переживает и отмену потока, и сам
 * прогон. Без этих двух хранилищ «Остановить» гасило поток, а через пару секунд
 * таймер поднимал агента заново: пользователь останавливал, а прогон продолжался.
 */
export const autoRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const stoppedByUser = new Set<string>();

/** Снять запланированный авто-рестарт и обнулить бюджет попыток. */
export function cancelAutoRetry(id: string): void {
  const timer = autoRetryTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    autoRetryTimers.delete(id);
  }
  autoRetries.delete(id);
}

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

/**
 * Перезапускать ли прогон самим после падения.
 *
 * Раньше решение принималось разбором ТЕКСТА ошибки по шаблону («network»,
 * «timed out», «50[234]»). Текст же приходил с пользовательским вводом внутри:
 * вложение с именем `network.zip` или `report 503.pdf` объявлялось «временным
 * сбоем», и клиент дважды молча переотправлял заведомо отклонённое сообщение —
 * несколько секунд тишины вместо ответа. Теперь решает только структурный
 * признак: `retriable` от сервера (он же и разбирает текст CLI — но свой) либо
 * обрыв связи, замеченный самим клиентом. Отказ с кодом не ретраится никогда.
 */
export function shouldAutoRetry(input: {
  error?: string;
  errorCode?: string;
  errorRetriable?: boolean;
  lastPrompt?: string;
  spentRetries: number;
  maxRetries: number;
  stoppedByUser: boolean;
}): boolean {
  if (!input.error || !input.lastPrompt) return false;
  if (input.errorCode) return false;
  if (input.errorRetriable !== true) return false;
  if (input.spentRetries >= input.maxRetries) return false;
  // Остановлено человеком — никаких «сам перезапущу»: кнопка «Остановить»
  // означает «хватит», даже если сбой выглядел временным.
  return !input.stoppedByUser;
}

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

/** Допуск между часами реестра и записью транскрипта (мс): часы одни, но не атомарные. */
const START_SKEW_MS = 1000;

/**
 * Что отправить при авто-повторе: задачу заново или «продолжай».
 *
 * Свою реплику CLI пишет в транскрипт раньше всего остального. Если она там
 * уже есть, повтор того же текста даёт разговор с двумя одинаковыми репликами
 * подряд: агент начинает всё заново, хотя половина сделанного уже в истории.
 * Поэтому смотрим на транскрипт: реплика после старта прогона есть — просим
 * продолжить с места обрыва; нет — прогон до неё не дожил, и отправляем её саму.
 */
export function pickRetryPrompt(input: {
  lastPrompt: string;
  /** Старт упавшего прогона по часам сервера; неизвестен — до модели не дошло. */
  startedAt?: number;
  history: { role: string; timestamp: string }[];
  continuation: string;
}): string {
  if (input.startedAt === undefined) return input.lastPrompt;
  const cutoff = input.startedAt - START_SKEW_MS;
  const delivered = input.history.some(
    (message) => message.role === 'user' && Date.parse(message.timestamp) >= cutoff,
  );
  return delivered ? input.continuation : input.lastPrompt;
}

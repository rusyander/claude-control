/** Допуск между часами реестра и записью транскрипта (мс): часы одни, но не атомарные. */
export const START_SKEW_MS = 1000;

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

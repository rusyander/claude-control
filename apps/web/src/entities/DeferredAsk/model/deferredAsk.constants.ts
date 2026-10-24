/** Опрос списка D-n — страховка к рассылке `chat-deferred`, не основной путь. */
export const DEFERRED_REFETCH_MS = 60_000;

/** Записи, которые человек ещё может решить: ждущая и истёкшая (разрешение заново). */
export const OPEN_STATES = ['waiting', 'expired'] as const;

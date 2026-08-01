export const isWindows = process.platform === 'win32';

/** Дольше этого хук не ждём: в реальной работе он тоже не должен висеть. */
export const TIMEOUT_MS = 15_000;

/** Синтетический id результата произвольного прогона — заготовки его не используют. */
export const CUSTOM_FIXTURE_ID = 'custom';

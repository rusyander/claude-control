/**
 * Ограниченный повтор файловой операции. На Windows антивирус и индексатор держат файл долю
 * секунды — `rename` поверх него даёт EPERM/EBUSY/EACCES (09 §atomic replace); однократная
 * попытка роняла запись на здоровом диске (тот же урок, что у `safe-io` сервера). Повтор
 * ограничен: после последней попытки ошибка уходит наверх — ни бесконечного ожидания, ни
 * молчаливого «получилось».
 */

export const TRANSIENT_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Временные коды ЧТЕНИЯ: файл в этот миг держит или заменяет другой процесс (Windows — EPERM
 * у файла в середине `rename`, EBUSY у файла под исключительной блокировкой). EACCES сюда не
 * входит: на POSIX это настоящий запрет доступа, и ожидание его не снимет — только задержит
 * ответ «неизвестно».
 */
export const READ_TRANSIENT_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY']);

export interface RetryPolicy {
  attempts: number;
  /** Пауза перед попыткой `n` (с нуля) — растёт, чтобы сканер успел отпустить файл. */
  delayMs: (attempt: number) => number;
  /** Синхронная пауза; в тестах — подмена без реального сна. */
  sleep: (ms: number) => void;
}

export function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 6,
  delayMs: (attempt) => 25 * (attempt + 1),
  sleep: blockingSleep,
};

export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

/** Выполнить `op`; временные коды повторяются до `attempts` раз, прочие — сразу наверх. */
export function retryTransient<T>(
  op: () => T,
  policy: RetryPolicy = DEFAULT_RETRY,
  codes: ReadonlySet<string> = TRANSIENT_CODES,
): T {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return op();
    } catch (error) {
      if (attempt + 1 >= policy.attempts || !codes.has(errorCode(error))) throw error;
      policy.sleep(policy.delayMs(attempt));
    }
  }
}

/**
 * Пауза, которую прерывает `signal`. Слушатель отмены снимается, когда пауза
 * кончилась сама: опрос живёт часами на одном сигнале, и каждая пауза иначе
 * оставляла бы на нём свой слушатель навсегда.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

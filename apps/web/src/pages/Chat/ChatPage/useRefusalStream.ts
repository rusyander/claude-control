import { useMemo } from 'react';
import { coreRefusalOf, type CoreRefusal } from './coreRefusal';

type RunStreamLike = Parameters<typeof coreRefusalOf>[0];

/**
 * Отказ ядра запуску CLI (W3-17a) — строкой на месте композера; карточка ошибки ленты его не
 * повторяет, поэтому из потока для ленты ошибка снята. Иная ошибка хода идёт карточкой, как была.
 */
export function useRefusalStream<S extends RunStreamLike>(
  runStream: S,
): { refusal: CoreRefusal | null; stream: S | Omit<S, 'error'> } {
  const refusal = useMemo(() => coreRefusalOf(runStream), [runStream]);
  const stream = useMemo(() => {
    if (!refusal) return runStream;
    const { error: _shownAsLine, ...rest } = runStream;
    return rest;
  }, [refusal, runStream]);
  return { refusal, stream };
}

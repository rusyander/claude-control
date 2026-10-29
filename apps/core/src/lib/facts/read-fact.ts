import type { Fact, ReadClassDef } from '@agentdeck/contracts/core/facts';
import { READ_CLASSES, type ReadClassName } from './read-classes.ts';

/**
 * Единственная дорога внешнего чтения (01 §Facts, F25). Читатель отвечает значением или
 * «нет»; всё прочее — исключение, таймаут, негодное значение — становится `unknown(причина)`.
 * «Нет» возможно только как явный ответ читателя: из `catch` его не вернуть (линт
 * `agentdeck-core/no-absent-in-catch`, P44), иначе сбой диска снова читался бы как «нет файла».
 */

export const ABSENT: { absent: true } = Object.freeze({ absent: true as const });

/** Явное «прочитал — нет». Отдельная функция, чтобы линт видел её и в `catch`. */
export function absent(): { absent: true } {
  return ABSENT;
}

export function value<T>(v: T): { value: T } {
  return { value: v };
}

export type Reader<T> = () => Promise<T | { absent: true }> | T | { absent: true };

export interface ReadOptions<T> {
  /** Проверка формы прочитанного: `false` или исключение — `unknown('garbage: …')`. */
  validate?: (v: T) => boolean;
  /** Свой таймер — для тестов с поддельными часами. */
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

/**
 * «Нет» — только сам `ABSENT` (по ссылке), не форма: значение из файла, равное
 * `{"absent":true}`, иначе читалось как «файла нет» и минуло `validate` (ревью core-s2 F-53).
 */
function isAbsent(v: unknown): v is { absent: true } {
  return v === ABSENT;
}

function realTimer(fn: () => void, ms: number): { cancel(): void } {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return { cancel: () => clearTimeout(handle) };
}

export function readClass(name: ReadClassName): ReadClassDef {
  return READ_CLASSES[name];
}

export async function readFact<T>(
  name: ReadClassName,
  reader: Reader<T>,
  options: ReadOptions<T> = {},
): Promise<Fact<T>> {
  const def = READ_CLASSES[name];
  const setTimer = options.setTimer ?? realTimer;
  let timer: { cancel(): void } | undefined;
  const timeout = new Promise<Fact<T>>((resolve) => {
    timer = setTimer(
      () => resolve({ unknown: `timeout after ${def.timeoutMs} ms` }),
      def.timeoutMs,
    );
  });
  const attempt = (async (): Promise<Fact<T>> => {
    try {
      const got = await reader();
      if (isAbsent(got)) return ABSENT;
      if (options.validate && !options.validate(got as T))
        return { unknown: 'garbage: value failed validation' };
      return { value: got as T };
    } catch (error) {
      return { unknown: describeError(error) };
    }
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    timer?.cancel();
  }
}

export function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    const message = (error as { message?: unknown }).message;
    return (
      [
        typeof code === 'string' ? code : undefined,
        typeof message === 'string' ? message : undefined,
      ]
        .filter(Boolean)
        .join(': ') || 'error'
    );
  }
  return String(error);
}

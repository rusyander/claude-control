import type { Predicate } from '../observer.types.ts';
import { contextOf, toolEventOf, whereOf } from './facts.ts';

/**
 * Большое чтение (06:135, F4): файл больше 30 КиБ прочитан целиком, без окна — инструментом
 * чтения или формой чтения оболочки (`cat`). Размер — из stat в момент результата, не из текста.
 * Окно неизвестно (переходник его не сообщает) — размера в строке нет, предикат молчит. Окно
 * самого CLI (Qwen без окна режет файл до ~25 KB, проба M) — не «целиком»: тоже молчание.
 * Сработка — одна на (контекст, путь, отпечаток): тот же файл целиком второй раз — уже перечитывание.
 */

export const WASTE_BIG_READ = 'waste-big-read';

/** Порог F4: 30 × 1024 байт. */
export const BIG_READ_BYTES = 30 * 1024;

export const bigReadPredicate: Predicate<null> = {
  ids: [WASTE_BIG_READ],
  init: () => null,
  step(state, line) {
    const ev = toolEventOf(line);
    if (!ev) return { state, verdicts: [] };
    const d = ev.data;
    if (d.effectClass !== 'read' || d.isError || d.range !== null || d.sizeBytes === null)
      return { state, verdicts: [] };
    if (d.sizeBytes <= BIG_READ_BYTES) return { state, verdicts: [] };
    const ctx = contextOf(d);
    return {
      state,
      verdicts: [
        {
          fired: true,
          signal: WASTE_BIG_READ,
          subject: d.target,
          detail: `${d.sizeBytes} bytes read whole (limit ${BIG_READ_BYTES} without a window)`,
          reasons: [`${d.target} is ${d.sizeBytes} bytes > ${BIG_READ_BYTES}`, 'no offset/limit'],
          key: `${WASTE_BIG_READ}:${ctx}:${d.target}:${d.fileFp ?? d.sizeBytes}`,
          ...whereOf(line),
          inputs: [line.seq],
        },
      ],
    };
  },
};

import { JOURNAL_VERSION } from '@agentdeck/contracts/core/journal';

/**
 * Версии событий (01 §Versioning, P45): читатель принимает каждую версию, что ещё лежит на
 * диске, поднимая строку апкастерами `vN → vN+1` при чтении — файл никогда не переписывается.
 * Пишется только текущая версия. Старое поле не получает новый смысл.
 *
 * Сейчас версия одна; таблица пуста. Новая версия = апкастер сюда + фикстура
 * `__fixtures__/v<N>.jsonl` (тест P45 требует обе для каждой версии ниже текущей).
 */

export interface RawLine {
  v: number;
  kind: string;
  data: unknown;
  [key: string]: unknown;
}

export const UPCASTERS: Record<number, (line: RawLine) => RawLine> = {};

export function upcastToCurrent(
  line: RawLine,
  current: number = JOURNAL_VERSION,
  table = UPCASTERS,
): RawLine {
  if (line.v > current) throw new Error(`event v${line.v} is newer than this build (v${current})`);
  let at = line;
  while (at.v < current) {
    const up = Object.hasOwn(table, at.v) ? table[at.v] : undefined;
    if (!up) throw new Error(`no upcaster v${at.v} -> v${at.v + 1}`);
    const next = up(at);
    // Апкастер обязан поднять версию ровно на один шаг: иначе чтение крутилось бы вечно
    // (ревью core-s2 F-103) или перескакивало через шаг таблицы.
    if (next.v !== at.v + 1)
      throw new Error(`upcaster v${at.v} -> v${next.v}, expected v${at.v + 1}`);
    at = next;
  }
  return at;
}

import type { DiffLine } from '@claude-control/contracts';
import { MAX_DIFF_BYTES, MAX_DIFF_LINES } from './constants.ts';

/**
 * Построчный дифф и работа с ханками — чистые функции без ввода-вывода.
 *
 * Дифф — свой минимальный LCS по строкам, без npm-зависимостей. Большие и
 * бинарные файлы не разбираем: держим ленту дешёвой и не тащим мусор в UI.
 */

/** Похоже ли на бинарный файл — есть NUL-байт, которого в текстовых конфигах нет. */
export function isBinary(text: string): boolean {
  return text.includes('\u0000');
}

export function tooBig(before: string, after: string): boolean {
  return (
    before.length > MAX_DIFF_BYTES ||
    after.length > MAX_DIFF_BYTES ||
    countLines(before) > MAX_DIFF_LINES ||
    countLines(after) > MAX_DIFF_LINES
  );
}

function countLines(text: string): number {
  if (!text) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') count += 1;
  return count;
}

/**
 * Разбор текста на строки для сравнения. CRLF приводим к LF, чтобы разница в
 * концах строк не выглядела как правка всего файла; единственный завершающий
 * перевод строки отбрасываем — иначе у файла с финальным переводом появлялась
 * бы фантомная пустая строка.
 */
function toLines(text: string): string[] {
  if (text === '') return [];
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  return normalized.split('\n');
}

/**
 * Построчный дифф двух версий текста через LCS. Наибольшая общая подпоследо-
 * вательность строк — это «неизменные» строки; всё, что в неё не вошло, слева
 * удалено, справа добавлено. Возвращает строки по порядку и счётчики +N/−M.
 *
 * Чистая функция без ввода-вывода: отдельно тестируется на собранных руками
 * строках. Сложность O(n·m) по числу строк — оправдана верхним пределом
 * MAX_DIFF_LINES у вызывающей стороны.
 */
export function diffLines(
  before: string,
  after: string,
): { lines: DiffLine[]; added: number; removed: number } {
  const a = toLines(before);
  const b = toLines(after);
  const n = a.length;
  const m = b.length;

  // dp[i][j] — длина LCS суффиксов a[i..] и b[j..].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;

  // Обход по восстановленному пути LCS: совпало — контекст; иначе шаг туда, где
  // LCS не убывает, порождая удаление (слева) или добавление (справа).
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'ctx', text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push({ kind: 'del', text: a[i]! });
      removed += 1;
      i += 1;
    } else {
      lines.push({ kind: 'add', text: b[j]! });
      added += 1;
      j += 1;
    }
  }
  while (i < n) {
    lines.push({ kind: 'del', text: a[i]! });
    removed += 1;
    i += 1;
  }
  while (j < m) {
    lines.push({ kind: 'add', text: b[j]! });
    added += 1;
    j += 1;
  }

  return { lines, added, removed };
}

/**
 * Пронумеровать ханки: непрерывный ряд строк add/del — один ханк, строка ctx
 * его разрывает. Индекс проставляется строкам правок (add/del), у контекста
 * остаётся не задан. Ровно эту же нумерацию воспроизводит `buildRevertedText`
 * и клиент — так номер ханка из запроса указывает на тот же блок, что видит
 * пользователь.
 */
export function assignHunks(lines: DiffLine[]): void {
  let hunk = -1;
  let inHunk = false;
  for (const line of lines) {
    if (line.kind === 'ctx') {
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      hunk += 1;
      inHunk = true;
    }
    line.hunk = hunk;
  }
}

/**
 * Пересобрать текущий файл, откатив ОДИН ханк к состоянию копии.
 *
 * Дифф ориентирован «копия → текущий файл»: строки add есть в текущем файле и
 * нет в копии, строки del — наоборот. Чтобы сохранить текущий файл, всюду берём
 * его сторону (add) и отбрасываем сторону копии (del). В выбранном ханке —
 * ровно обратное: берём копию (del), отбрасываем текущее (add). Остальные ханки
 * не трогаются вовсе.
 *
 * Возвращает undefined, если ханка с таким индексом в диффе нет.
 */
export function buildRevertedText(
  lines: DiffLine[],
  hunkIndex: number,
  currentText: string,
): string | undefined {
  const out: string[] = [];
  let hunk = -1;
  let inHunk = false;
  let matched = false;

  for (const line of lines) {
    if (line.kind === 'ctx') {
      inHunk = false;
      out.push(line.text);
      continue;
    }
    if (!inHunk) {
      hunk += 1;
      inHunk = true;
    }

    if (hunk === hunkIndex) {
      matched = true;
      // Выбранный ханк → сторона копии: восстанавливаем её строки (del), новые
      // строки текущего файла (add) выкидываем.
      if (line.kind === 'del') out.push(line.text);
    } else {
      // Прочие ханки → оставляем как в текущем файле (add), сторону копии (del)
      // не возвращаем.
      if (line.kind === 'add') out.push(line.text);
    }
  }

  if (!matched) return undefined;

  const text = out.join('\n');
  // Финальный перевод строки берём у текущего файла: toLines его отбрасывает,
  // поэтому возвращаем, чтобы не «съесть» перевод строки в конце конфига.
  return currentText.endsWith('\n') && text !== '' ? `${text}\n` : text;
}

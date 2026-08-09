/**
 * Построчное сравнение «до» и «сейчас».
 *
 * Считается на телефоне, а не на сервере, намеренно: сервер отдаёт оба текста
 * одним ответом (они нужны и панели), и просить у него ещё и готовый дифф
 * значило бы завести третий формат ради одного экрана.
 *
 * Алгоритм — наибольшая общая подпоследовательность по строкам, та же основа,
 * что у `diff` в git. Матрица квадратная, поэтому на больших файлах сравнение не
 * запускается вовсе: показать текст без разметки честнее, чем подвесить экран.
 */

export type DiffKind = 'same' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/** Потолок: 1500×1500 — это ~2 млн ячеек, предел, за которым телефон думает секундами. */
const MAX_LINES = 1500;

export function canDiff(before: string, after: string): boolean {
  return countLines(before) <= MAX_LINES && countLines(after) <= MAX_LINES;
}

function countLines(text: string): number {
  return text.split('\n').length;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const source = before.split('\n');
  const target = after.split('\n');

  // Длина НОП для каждого суффикса пары: ячейка [i][j] — сколько строк совпадёт,
  // если начать сравнение с i-й и j-й строки.
  const table: number[][] = Array.from({ length: source.length + 1 }, () =>
    new Array<number>(target.length + 1).fill(0),
  );
  for (let i = source.length - 1; i >= 0; i -= 1) {
    for (let j = target.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        source[i] === target[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < source.length && j < target.length) {
    if (source[i] === target[j]) {
      lines.push({ kind: 'same', text: source[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ kind: 'removed', text: source[i] });
      i += 1;
    } else {
      lines.push({ kind: 'added', text: target[j] });
      j += 1;
    }
  }
  while (i < source.length) {
    lines.push({ kind: 'removed', text: source[i] });
    i += 1;
  }
  while (j < target.length) {
    lines.push({ kind: 'added', text: target[j] });
    j += 1;
  }
  return lines;
}

/**
 * Только изменённые куски с контекстом вокруг. Целый файл, где правок три
 * строки, на телефоне листать невозможно.
 */
export function collapse(lines: DiffLine[], context = 3): DiffLine[] {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let offset = -context; offset <= context; offset += 1) keep.add(index + offset);
  });

  const result: DiffLine[] = [];
  let skipping = false;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      result.push(line);
      skipping = false;
    } else if (!skipping) {
      result.push({ kind: 'same', text: '⋯' });
      skipping = true;
    }
  });
  return result;
}

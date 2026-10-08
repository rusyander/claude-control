import type { DiffLine } from './diff.types';

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

import type { DiffLine } from './diff.types';

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

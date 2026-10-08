/** Потолок: 1500×1500 — это ~2 млн ячеек, предел, за которым телефон думает секундами. */
const MAX_LINES = 1500;

export function canDiff(before: string, after: string): boolean {
  return countLines(before) <= MAX_LINES && countLines(after) <= MAX_LINES;
}

function countLines(text: string): number {
  return text.split('\n').length;
}

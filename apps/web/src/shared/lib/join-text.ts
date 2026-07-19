/** Склейка двух фрагментов текста одним пробелом (пустые игнорируются). */
export function joinText(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (left === '') return right;
  if (right === '') return left;
  return `${left} ${right}`;
}

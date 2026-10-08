/** Секунды поля: пусто — как у пресета; не число — NaN, его отвергнет схема. */
export function secondsOf(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

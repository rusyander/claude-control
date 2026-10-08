/** Трёхзначный отбор карантина в значение `select` и обратно. */
export function mutedValue(muted: boolean | undefined): string {
  if (muted === true) return 'only';
  if (muted === false) return 'without';
  return '';
}

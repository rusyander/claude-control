/** Английское порядковое числительное: 1st, 2nd, 3rd, 4th, 11th, 22nd. */
export function englishOrdinal(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[value % 10] ?? 'th';
  return `${value}${suffix}`;
}

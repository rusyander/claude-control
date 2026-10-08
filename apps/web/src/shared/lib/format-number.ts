/** Компактная запись больших чисел: 21 152 612 996 → 21,2 млрд. */
export function formatCompact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

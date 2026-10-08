/** Денежная оценка. Всегда подписывается как приблизительная. */
export function formatMoney(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value < 100 ? 2 : 0,
  }).format(value);
}

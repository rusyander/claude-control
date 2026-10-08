/**
 * Доля расхождения процентом. Округляем до сотых: расхождение в один пиксель
 * из миллиона — это 0,0001 %, и «0 %» на экране означало бы «совпало», хотя
 * порог оно могло и превысить.
 */
export function ratioPercent(ratio: number | undefined): string {
  if (ratio === undefined || Number.isNaN(ratio)) return '';
  return `${(ratio * 100).toFixed(2)}%`;
}

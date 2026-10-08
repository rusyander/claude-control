/** Подписи единиц в языке интерфейса; байты склоняются («3 байта»), поэтому — функция. */
export interface ByteUnits {
  bytes: (count: number) => string;
  kilobytes: string;
  megabytes: string;
}

/**
 * Размер для текста, который человек читает на своём языке: «25 МБ», «1,5 КБ»,
 * «3 байта». `formatBytes` рядом отдаёт «25.0 MB» — годится в таблицу, но в
 * русской фразе об отказе латиница и точка вместо запятой режут глаз.
 */
export function formatBytesIn(bytes: number, units: ByteUnits, locale: string): string {
  if (bytes < 1024) return units.bytes(bytes);
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  // Десятые — вверх: размер рядом с пределом не вправе оказаться пределом.
  // «Больше 20 МБ не прикладывается: x.png — 20 МБ» спорило само с собой, а
  // файл без байта до мегабайта читался «1 024 КБ» (F-334). Деление на степень
  // двойки и умножение на 10 точны в double — погрешности у ceil нет.
  const up = (value: number): number => Math.ceil(value * 10) / 10;
  const kilobytes = up(bytes / 1024);
  if (kilobytes < 1024) return `${number.format(kilobytes)} ${units.kilobytes}`;
  return `${number.format(up(bytes / (1024 * 1024)))} ${units.megabytes}`;
}

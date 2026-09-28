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

/** Человекочитаемый размер файла. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Размер мелкого файла — скрипта или артефакта чата. В отличие от `formatBytes`
 * шкала обрывается на килобайтах: файлы этих разделов до мегабайта не дорастают,
 * а лишняя ступень только сбивает при сравнении соседних строк списка.
 */
export function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Дата в коротком локальном формате. */
export function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Дата и время: для ленты изменений важен ещё и час правки. */
export function formatDateTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Компактное число токенов: 1234 → «1.2k», 2_500_000 → «2.5M». */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(Math.round(tokens));
}

/**
 * Расход в выбранных единицах: токены (по умолчанию) или деньги. Так пользователь
 * видит именно то, что ему привычнее, а второе можно включить в настройках.
 */
export function formatSpend(unit: 'tokens' | 'money', tokens: number, costUsd: number): string {
  return unit === 'money' ? `$${costUsd.toFixed(3)}` : `${formatTokens(tokens)} tok`;
}

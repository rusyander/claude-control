import type { PricingEntry } from '@claude-control/contracts';

/**
 * Строки, действующие сегодня. У части моделей цена меняется по расписанию
 * (вводный тариф), и показывать обе разом — путать: в таблице должна стоять
 * та цена, по которой считается расход прямо сейчас.
 */
export function activeEntries(entries: PricingEntry[]): PricingEntry[] {
  const now = Date.now();

  return entries.filter((entry) => {
    if (entry.from && now < Date.parse(`${entry.from}T00:00:00`)) return false;
    if (entry.until && now > Date.parse(`${entry.until}T23:59:59`)) return false;
    return true;
  });
}

/**
 * Цена за миллион токенов: $5, $0.50, $6.25 — без хвостов вида «$5.00».
 *
 * Ставки нет — прочерк. Часовую запись кэша сервер проставляет сам (по прайсу
 * либо равной введённой пятиминутной), и пустой она приходит разве что от
 * старого сервера при разработке. Показать в этом месте выдуманное число хуже,
 * чем показать, что цифры нет.
 */
export function formatPrice(value: number | undefined): string {
  if (value === undefined) return '—';
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

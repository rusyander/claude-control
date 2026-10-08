import type { PricingEntry } from '@agentdeck/contracts';

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

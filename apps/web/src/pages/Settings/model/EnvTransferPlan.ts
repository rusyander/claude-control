import type { EnvTransferPlanEntry } from '../EnvTransfer.types';

/**
 * Разбор плана разворота архива — отдельно от разметки, потому что это правила,
 * а не оформление: что можно отметить и что отмечено по умолчанию.
 *
 * Умолчание намеренно осторожное — только НОВЫЕ записи. Перезапись своей
 * конфигурации чужой должна быть осознанным щелчком, а не тем, что панель
 * подставила заранее.
 */

/** Записи, которые вообще можно применить: нерешённым некуда лечь. */
export function selectableEntries(entries: EnvTransferPlanEntry[]): EnvTransferPlanEntry[] {
  return entries.filter((entry) => entry.status !== 'unresolved');
}

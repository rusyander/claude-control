import type { PlatformRuleRow } from '@agentdeck/contracts';

/** Правила, которые только видно: ими распоряжается владелец контура. */
export function observedRules(rows: readonly PlatformRuleRow[] = []): PlatformRuleRow[] {
  return rows.filter((row) => row.kind === 'observed' || !row.field);
}

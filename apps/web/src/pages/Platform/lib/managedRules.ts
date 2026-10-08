import type { PlatformRuleRow } from '@agentdeck/contracts';

/** Правила, которыми распоряжается панель. */
export function managedRules(rows: readonly PlatformRuleRow[] = []): PlatformRuleRow[] {
  return rows.filter((row) => row.kind === 'request' && row.field);
}

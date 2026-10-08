import type { IconName } from '@shared/ui/icon';
import { type RulesTabId } from './tabs.types';

export const RULES_TAB_ICONS: Record<RulesTabId, IconName> = {
  all: 'rules',
  enabled: 'eye',
  disabled: 'eyeOff',
};

/** Правила открытой вкладки: «Все» — без отбора. */
export function rulesInTab<T extends { isEnabled: boolean }>(
  rules: readonly T[],
  tab: RulesTabId,
): T[] {
  if (tab === 'all') return [...rules];
  const wantEnabled = tab === 'enabled';
  return rules.filter((rule) => rule.isEnabled === wantEnabled);
}

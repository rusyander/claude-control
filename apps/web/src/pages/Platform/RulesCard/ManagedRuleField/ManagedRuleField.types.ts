import type { PlatformRuleRow, Platform } from '@agentdeck/contracts';
import type { RuleDrafts } from '../useRuleDrafts';

export interface ManagedRuleFieldProps {
  row: PlatformRuleRow;
  platform: Platform;
  drafts: RuleDrafts;
  /**
   * Набор контура не добавить, пока включена прослойка (взаимное исключение
   * считает `RulesCard`: вторая его половина запирает выключатель прослойки).
   */
  toolsLocked: boolean;
  update: (next: Platform) => void;
}

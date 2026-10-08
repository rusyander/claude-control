import type {
  Platform,
  PlatformRuleRow,
  PlatformRuleConflict,
  PlatformRulesApplies,
} from '@agentdeck/contracts';
import type { RuleDrafts } from '../useRuleDrafts';

export interface PlatformRulesColumnProps {
  platform: Platform;
  rules: PlatformRuleRow[];
  drafts: RuleDrafts;
  toolsLocked: boolean;
  update: (next: Platform) => void;
  /** Пересечения с нашими правилами — отметка под строкой, которой касаются. */
  conflicts: readonly PlatformRuleConflict[];
  /** Колонка снята выбором «чьи правила действуют» — каким именно. */
  offBy: PlatformRulesApplies | undefined;
}

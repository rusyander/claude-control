import type { Platform, PlatformRuleConflict } from '@agentdeck/contracts';

export interface RuleConflictsProps {
  platform: Platform;
  conflicts: PlatformRuleConflict[];
  update: (next: Platform) => void;
  /** Выход «убрать инструменты контура» очищает и недописанное поле. */
  clearToolsDraft: () => void;
}

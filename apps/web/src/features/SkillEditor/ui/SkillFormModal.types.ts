import type { Skill } from '@claude-control/contracts';

export interface SkillFormModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Пусто — создание нового скилла, иначе правка существующего. */
  skill?: Skill;
}

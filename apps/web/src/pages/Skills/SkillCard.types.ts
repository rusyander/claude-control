import type { Skill } from '@claude-control/contracts';

export interface SkillCardProps {
  skill: Skill;
  onToggle: (isEnabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  isDeleting?: boolean;
}

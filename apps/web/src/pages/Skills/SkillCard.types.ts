import type { Skill } from '@agentdeck/contracts';

export interface SkillCardProps {
  skill: Skill;
  onToggle: (isEnabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  isDeleting?: boolean;
}

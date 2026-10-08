import type { PermissionRule } from '@agentdeck/contracts';

export interface ProjectPermissionFormProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** id проекта — куда пишем .claude/settings.json. */
  projectId: string;
  /** Пусто — создание нового права, иначе правка существующего. */
  rule?: PermissionRule;
}

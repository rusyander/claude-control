import type { PathResourceType } from '@agentdeck/contracts';

export interface PromoteQuestionProps {
  promote: { type: PathResourceType; draft: string };
  isPending: boolean;
  /** Проект проектной группы: ресурс ляжет в его `.claude`, а не в общий каталог. */
  projectPath?: string;
  onAccept: () => void;
  onDecline: () => void;
}

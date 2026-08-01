import type { ProjectInfo } from '@entities/Project';
import type { RunStatus } from '@shared/lib/agent-runs';

export interface ProjectRowProps {
  project: ProjectInfo;
  isActive: boolean;
  status: RunStatus;
  language: string;
  onOpen: () => void;
}

import type { ProjectFileChanges } from '@claude-control/contracts';

export interface ProjectCodeChangedProps {
  changes?: ProjectFileChanges;
  isLoading: boolean;
  selected?: string;
  onSelect: (path: string) => void;
}

import type { ProjectFileChanges } from '@agentdeck/contracts';

export interface ProjectCodeChangedProps {
  changes?: ProjectFileChanges;
  isLoading: boolean;
  selected?: string;
  onSelect: (path: string) => void;
}

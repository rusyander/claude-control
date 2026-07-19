import type { ProjectTab } from '@shared/lib/workspace';
import type { RunStatus } from '@shared/lib/agent-runs';

export interface WorkspaceTabsProps {
  projectTabs: ProjectTab[];
  activeTabId: string;
  /** Статусы агентов по нормализованному пути проекта — для цветных точек. */
  statuses?: Map<string, RunStatus>;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

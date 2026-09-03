import type { ProjectTab } from '@shared/lib/workspace';
import type { RunStatus } from '@shared/lib/agent-runs';

export interface WorkspaceTabsProps {
  projectTabs: ProjectTab[];
  activeTabId: string;
  /** Статусы агентов по нормализованному пути проекта — для цветных точек. */
  statuses?: Map<string, RunStatus>;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** Новый порядок табов после перетаскивания — id в порядке ленты. */
  onReorder: (orderedIds: string[]) => void;
  /** Шаг табу с клавиатуры: −1 влево, +1 вправо. */
  onMove: (id: string, delta: number) => void;
}

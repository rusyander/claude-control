import type { ProjectInfo } from '@entities/Project';
import type { RunStatus } from '@shared/lib/agent-runs';

export interface ProjectListProps {
  projects: ProjectInfo[];
  isLoading: boolean;
  /** Нормализованный путь активного проекта-таба — для подсветки. */
  activeId?: string;
  /** Статусы агентов по нормализованному пути проекта — для цветных точек. */
  statuses?: Map<string, RunStatus>;
  onOpen: (project: ProjectInfo) => void;
  /** Открыть системный диалог добавления папки проекта. */
  onAddFolder?: () => void;
  /** Открыть окно параллельного запуска в нескольких проектах. */
  onParallelLaunch?: () => void;
}

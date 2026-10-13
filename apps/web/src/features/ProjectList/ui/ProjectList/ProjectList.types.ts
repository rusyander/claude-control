import type { Project } from '@agentdeck/contracts';
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
  /** Проекты страницы «Проекты»: стоят в списке всегда и первыми, с меткой. */
  registry?: Project[];
  /** Добавить проект на страницу «Проекты» одним нажатием из строки. */
  onRegister?: (project: ProjectInfo) => void;
  /** Путь проекта, который добавляется прямо сейчас, — его кнопка выключена. */
  registeringPath?: string | undefined;
  /** Нормализованные пути открытых вкладок — для окна «Открыть несколько». */
  openIds?: ReadonlySet<string>;
  /** Открыть отмеченные проекты вкладками разом; не задано — кнопки нет. */
  onOpenMany?: (projects: ProjectInfo[]) => void;
}

import type { ChatSummary } from '@claude-control/contracts';
import type { RunStatus } from '@shared/lib/agent-runs';
import type { ProjectInfo } from '@entities/Project';

/** Что показано в боковой панели домашнего таба. */
export type HomeSection = 'chats' | 'projects';

export interface ChatSidebarProps {
  /** Активен домашний таб: только там есть переключатель «Чаты/Проекты». */
  isHome: boolean;
  chats: ChatSummary[];
  isChatsLoading: boolean;
  activeChatId?: string;
  /** Статус агента по каждому разговору — для цветных точек в списке. */
  chatStatuses?: Map<string, RunStatus>;
  onSelectChat: (chat: ChatSummary) => void;
  onCreateChat: () => void;
  projects: ProjectInfo[];
  isProjectsLoading: boolean;
  /** Нормализованный путь активного проекта-таба — для подсветки. */
  activeProjectId?: string;
  projectStatuses?: Map<string, RunStatus>;
  onOpenProject: (project: ProjectInfo) => void;
  onAddFolder: () => void;
  onParallelLaunch: () => void;
}

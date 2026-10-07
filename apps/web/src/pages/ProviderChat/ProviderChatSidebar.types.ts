import type { ProviderChatProject, ProviderChatSummary } from '@agentdeck/contracts';

/** Что показывает левая колонка: разговоры активного провайдера или проекты всех. */
export type ProviderChatSidebarSection = 'chats' | 'projects';

export interface ProviderChatSidebarProps {
  chats: ProviderChatSummary[];
  isLoading: boolean;
  activeChatId?: string;
  onSelect: (chatId: string) => void;
  onCreate: () => void;
  isCreating: boolean;
  /** Проекты всех провайдеров — вкладка «Проекты». */
  projects: ProviderChatProject[];
  isProjectsLoading: boolean;
  providerId: string;
  providerName: string;
  /** Новый разговор активного провайдера в каталоге проекта. */
  onStartInProject: (path: string) => void;
}

import type { ProviderChatSummary } from '@claude-control/contracts';

export interface ProviderChatSidebarProps {
  chats: ProviderChatSummary[];
  isLoading: boolean;
  activeChatId?: string;
  onSelect: (chatId: string) => void;
  onCreate: () => void;
  isCreating: boolean;
}

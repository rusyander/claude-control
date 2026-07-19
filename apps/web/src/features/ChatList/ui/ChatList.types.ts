import type { ChatSummary } from '@agentdeck/contracts';

export interface ChatListProps {
  chats: ChatSummary[];
  isLoading: boolean;
  activeId?: string;
  onSelect: (chat: ChatSummary) => void;
  onCreate: () => void;
}

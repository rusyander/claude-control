import type { ChatSummary } from '@claude-control/contracts';

/** Режим поиска в списке: по названию/проекту/превью или по телу переписки. */
export type ChatSearchMode = 'title' | 'messages';

export interface ChatListProps {
  chats: ChatSummary[];
  isLoading: boolean;
  activeId?: string;
  onSelect: (chat: ChatSummary) => void;
  onCreate: () => void;
}

export interface ChatRowProps {
  chat: ChatSummary;
  isActive: boolean;
  language: string;
  onSelect: () => void;
  /** Фрагмент из тела переписки — показывается вместо превью в поиске по сообщениям. */
  snippet?: string;
  /** Сколько раз запрос встретился в переписке. */
  matchCount?: number;
  /** Запрос — для подсветки совпадений в сниппете. */
  query?: string;
}

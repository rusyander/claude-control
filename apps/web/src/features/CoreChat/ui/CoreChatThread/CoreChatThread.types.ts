import type { ChatItem } from '../../model/coreChat.types';

export interface CoreChatThreadProps {
  items: ChatItem[];
  /** Ушедшие сообщения человека, которых сеанс ещё не отдал. */
  pending: string[];
}

import type { ChatMessage } from '@claude-control/contracts';
import type { StreamState } from '@entities/Chat/model/useChatStream';

export interface ChatMessagesProps {
  messages: ChatMessage[];
  /** Ответ, который набирается прямо сейчас. */
  stream: StreamState;
  isLoading: boolean;
  /** Повторить свой запрос, отредактировав его текст. */
  onEdit: (text: string) => void;
}

export interface MessageBubbleProps {
  message: ChatMessage;
  onEdit: (text: string) => void;
}

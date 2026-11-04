import type { ProviderChatMessage } from '@agentdeck/contracts';

export interface ProviderChatMessagesProps {
  messages: ProviderChatMessage[];
  providerName: string;
  /** Ни одного старого разговора не выбрано: на месте ленты — кнопка нового чата ядра. */
  isEmptyState: boolean;
  onCreate: () => void;
  /** Разговор, к которому привязаны сохранённые рисунки и колоды ответа. */
  mediaChatId?: string;
  mediaModel?: string;
}

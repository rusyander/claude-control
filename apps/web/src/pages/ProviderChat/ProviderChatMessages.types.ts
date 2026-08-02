import type { ProviderChatMessage } from '@claude-control/contracts';

export interface ProviderChatMessagesProps {
  messages: ProviderChatMessage[];
  providerName: string;
  /** Текст, напечатанный к этому моменту: показывается отдельной репликой. */
  partial: string;
  isRunning: boolean;
  /** Нет разговоров вовсе — подсказка отличается от «разговор пустой». */
  isEmptyState: boolean;
  /** Начать разговор прямо из пустого экрана. */
  onCreate: () => void;
  isCreating: boolean;
}

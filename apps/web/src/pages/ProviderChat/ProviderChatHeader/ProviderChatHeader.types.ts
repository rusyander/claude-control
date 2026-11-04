import type { ProviderChatDetail } from '@agentdeck/contracts';

export interface ProviderChatHeaderProps {
  chat?: ProviderChatDetail;
  providerName: string;
  onRename: (title: string) => void;
  onDelete: () => void;
  /** Новый чат ядра у этого CLI в каталоге разговора: ход идёт там, а не здесь. */
  onContinue: () => void;
}

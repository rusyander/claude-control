import type { ProviderChatDetail, ProviderRunnerInfo } from '@agentdeck/contracts';

export interface ProviderChatHeaderProps {
  chat?: ProviderChatDetail;
  providerName: string;
  runner?: ProviderRunnerInfo;
  isRunning: boolean;
  onRename: (title: string) => void;
  onPickWorkdir: () => void;
  onDelete: () => void;
  onStop: () => void;
  /**
   * Перезапустить разговор в чистом виде (Т7). Сессии у чужого CLI нет, поэтому
   * это новый разговор с контрольной точкой; пусто — перезапускать нечего.
   */
  onRestart?: () => void;
  isRestarting?: boolean;
}

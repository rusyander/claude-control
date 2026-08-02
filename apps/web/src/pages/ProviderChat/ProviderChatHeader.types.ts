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
}

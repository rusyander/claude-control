import type { ProviderChatProject } from '@agentdeck/contracts';

export interface ProviderChatProjectsProps {
  projects: ProviderChatProject[];
  isLoading: boolean;
  /** Активный провайдер: его бейдж выделен, новый разговор заводится у него. */
  providerId: string;
  providerName: string;
  /** Начать новый разговор активного провайдера в каталоге проекта. */
  onStart: (path: string) => void;
  /** Разговор уже заводится — кнопки ждут. */
  isStarting: boolean;
}

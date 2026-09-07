import type {
  IntegrationId,
  IntegrationStatus,
  IntegrationsSettings,
} from '@agentdeck/contracts';

export interface IntegrationCardProps {
  id: IntegrationId;
  /** Итог последней живой проверки. Нет — сервер о коннекторе ещё не отвечал. */
  status: IntegrationStatus | undefined;
  settings: IntegrationsSettings;
}

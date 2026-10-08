import type { IntegrationsSettings, IntegrationId, TelegramEvent } from '@agentdeck/contracts';

/** На что подписана карточка. У коннекторов без подписки список пуст. */
export function eventsOf(settings: IntegrationsSettings, id: IntegrationId): TelegramEvent[] {
  if (id === 'telegram') return settings.telegram.events;
  if (id === 'webhook') return settings.webhook.events;
  return [];
}

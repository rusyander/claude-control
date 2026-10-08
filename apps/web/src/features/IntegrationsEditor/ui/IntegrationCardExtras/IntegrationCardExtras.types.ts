import type { IntegrationId, TelegramEvent } from '@agentdeck/contracts';

export interface IntegrationCardExtrasProps {
  id: IntegrationId;
  events: TelegramEvent[];
  onEventsChange: (events: TelegramEvent[]) => void;
  allEvents: readonly TelegramEvent[];
}

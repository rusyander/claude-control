import type { IntegrationId, AppSettings, IntegrationsSettings } from '@agentdeck/contracts';
import { readIntegrations } from './settings';

/** Настройки одного коннектора — тип выводится из его id, без ручных развилок. */
export function readIntegration<T extends IntegrationId>(
  settings: AppSettings | undefined,
  id: T,
): IntegrationsSettings[T] {
  return readIntegrations(settings)[id];
}

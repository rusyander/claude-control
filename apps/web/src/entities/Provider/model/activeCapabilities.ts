import type { ProvidersResponse } from '@agentdeck/contracts';
import type { ProviderCapabilities } from './gating.types';
import { activeProvider } from './gating';

/** Карта возможностей активного провайдера (или `undefined`, пока не загружено). */
export function activeCapabilities(data: ProvidersResponse | undefined): ProviderCapabilities {
  return activeProvider(data)?.capabilities;
}

import type { ProviderInfo, ProvidersResponse } from '@agentdeck/contracts';

/** Активный провайдер из ответа эндпоинта. */
export function activeProvider(data: ProvidersResponse | undefined): ProviderInfo | undefined {
  if (!data) return undefined;
  return data.providers.find((provider) => provider.id === data.active);
}

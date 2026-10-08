import type { ProviderCheckResult, ProviderChecksResponse } from '@agentdeck/contracts';

/** Итог проверки конкретного провайдера (или `undefined`, если её не было). */
export function findCheck(
  checks: ProviderChecksResponse | undefined,
  providerId: string,
): ProviderCheckResult | undefined {
  return checks?.checks[providerId];
}

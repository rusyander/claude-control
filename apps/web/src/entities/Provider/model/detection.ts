import type { ProviderDetection, ProviderDetectResponse } from '@agentdeck/contracts';

/** Детект по конкретному провайдеру (или `undefined`, пока не загружено). */
export function findDetection(
  data: ProviderDetectResponse | undefined,
  providerId: string,
): ProviderDetection | undefined {
  return data?.providers.find((item) => item.id === providerId);
}

import type { DriftAddress } from './PortabilityApi.types';
import type { SubscriptionDriftPlan } from '@agentdeck/contracts/portable-subscribe';
import { apiClient } from '@shared/api/client';
import { useMutation } from '@tanstack/react-query';

export async function postDriftPlan(
  address: DriftAddress,
): Promise<{ plan: SubscriptionDriftPlan }> {
  const { data } = await apiClient.post<{ plan: SubscriptionDriftPlan }>(
    '/portability/subscription/drift/plan',
    address,
  );
  return data;
}

/**
 * Что сделает выбранный исход расхождения — до того, как он сделан.
 *
 * Отдельная пара «план → применение», а не поле общей пересборки: исход
 * разбирает ОДИН файл, и показать его вместе с пересборкой значило бы показать
 * два разных решения одним диффом.
 */
export function usePlanDrift() {
  return useMutation({ meta: { silentError: true }, mutationFn: postDriftPlan });
}

import type { SubscriptionAddress } from './PortabilityApi.types';
import type { SubscriptionSyncPlan } from '@agentdeck/contracts/portable-subscribe';
import { apiClient } from '@shared/api/client';
import { useMutation } from '@tanstack/react-query';

export async function postSubscriptionPlan(
  address: SubscriptionAddress,
): Promise<{ plan: SubscriptionSyncPlan }> {
  const { data } = await apiClient.post<{ plan: SubscriptionSyncPlan }>(
    '/portability/subscription/plan',
    address,
  );
  return data;
}

/**
 * План пересборки: что разошлось с каноном и что из-за этого будет записано.
 *
 * Мутация по той же причине, что и план переноса: сервер ничего не пишет, но
 * считает план НАСТОЯЩЕЙ записью адаптеров по временным копиям, и тянуть это
 * фоном при каждом открытии страницы было бы неверно понятым «только чтением».
 */
export function usePlanSubscription() {
  return useMutation({ meta: { silentError: true }, mutationFn: postSubscriptionPlan });
}

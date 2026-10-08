import type { SubscriptionsAnswer } from '@agentdeck/contracts/portable-subscribe';
import { apiClient } from '@shared/api/client';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function getSubscriptions(): Promise<SubscriptionsAnswer> {
  const { data } = await apiClient.get<SubscriptionsAnswer>('/portability/subscriptions');
  return data;
}

/**
 * Все подписки панели — то, с чем экран ОТКРЫВАЕТСЯ.
 *
 * Обычный запрос списком, а не по выбранной цели: маршрут отдаёт их разом, и
 * человек, переключающий цель, не должен ждать сети ради ответа, который уже
 * лежит в кэше.
 */
export function useSubscriptions() {
  return useQuery({
    queryKey: queryKeys.portabilitySubscriptions,
    queryFn: getSubscriptions,
  });
}

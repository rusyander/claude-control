import type { SubscriptionAddress } from './PortabilityApi.types';
import { apiClient } from '@shared/api/client';
import { levelParams } from '../lib/levelParams';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function deleteSubscription(address: SubscriptionAddress): Promise<{ ok: boolean }> {
  const { data } = await apiClient.delete<{ ok: boolean }>('/portability/subscription', {
    params: { target: address.target, ...levelParams(address) },
  });
  return data;
}

/**
 * Забыть подписку целиком — вместе с памятью о спроецированном. Файлы цели
 * остаются такими, какими их оставили: панель перестаёт их обновлять, а не
 * стирает.
 */
export function useForgetSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { silentError: true },
    mutationFn: deleteSubscription,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.portabilitySubscriptions });
    },
  });
}

import type { SubscriptionAddress } from './PortabilityApi.types';
import type { EnvItemKind } from '@agentdeck/contracts/portable-env';
import type { EnvSubscription } from '@agentdeck/contracts/portable-subscribe';
import { apiClient } from '@shared/api/client';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function putSubscription(
  request: SubscriptionAddress & { layers: readonly EnvItemKind[] },
): Promise<{ subscription: EnvSubscription }> {
  const { data } = await apiClient.put<{ subscription: EnvSubscription }>(
    '/portability/subscription',
    request,
  );
  return data;
}

/**
 * Подписать цель на слои — и отписать ею же, пустым списком.
 *
 * Отписка ничего у цели не удаляет: подписка её файлами не владела, она
 * обещала их обновлять. Память о спроецированном сохраняется, поэтому повторная
 * подписка не объявит новым каждый файл, который панель уже писала.
 */
export function useSaveSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { silentError: true },
    mutationFn: putSubscription,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.portabilitySubscriptions });
    },
  });
}

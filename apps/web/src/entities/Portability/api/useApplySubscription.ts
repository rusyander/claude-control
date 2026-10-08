import type { SubscriptionAddress } from './PortabilityApi.types';
import type { SubscriptionApplyAnswer } from '@agentdeck/contracts/portable-subscribe';
import { apiClient } from '@shared/api/client';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function postSubscriptionApply(
  request: SubscriptionAddress & { fingerprint: string },
): Promise<SubscriptionApplyAnswer> {
  const { data } = await apiClient.post<SubscriptionApplyAnswer>(
    '/portability/subscription/apply',
    request,
  );
  return data;
}

/**
 * Пересобрать разошедшееся. Пишет тот же `applyTransfer`, что и разовый
 * перенос, — с теми же резервными копиями и тем же откатом при провале.
 *
 * После успеха устаревает не только список подписок, но и паспорт ЦЕЛИ: в неё
 * только что записали, и прежний паспорт говорил бы о среде, которой уже нет.
 */
export function useApplySubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { silentError: true },
    mutationFn: postSubscriptionApply,
    onSuccess: (_answer, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.portabilitySubscriptions });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.portabilityPassport(
          variables.target,
          variables.scope,
          variables.project,
        ),
      });
    },
  });
}

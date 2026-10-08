import type { DriftAddress } from './PortabilityApi.types';
import type { SubscriptionDriftAnswer } from '@agentdeck/contracts/portable-subscribe';
import { apiClient } from '@shared/api/client';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { PANEL_CANON_PROVIDER } from '@agentdeck/contracts/portable-subscribe';

export async function postDriftApply(
  request: DriftAddress & { fingerprint?: string },
): Promise<SubscriptionDriftAnswer> {
  const { data } = await apiClient.post<SubscriptionDriftAnswer>(
    '/portability/subscription/drift/apply',
    request,
  );
  return data;
}

/**
 * Сделать выбранное. `fingerprint` — того плана, который человеку ПОКАЗАЛИ;
 * у `unsubscribe` его нет, и это не упущение: этот исход не трогает у цели ни
 * одного байта, показывать в нём нечего.
 *
 * Паспорт цели устаревает у двух исходов из трёх, канон панели — у одного:
 * `canon` пишет в файлы САМОЙ панели, и после него устарел паспорт источника
 * канона, а не цели.
 */
export function useApplyDrift() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: postDriftApply,
    onSuccess: (answer, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.portabilitySubscriptions });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.portabilityPassport(
          answer.resolution === 'canon' ? PANEL_CANON_PROVIDER : variables.target,
          variables.scope,
          variables.project,
        ),
      });
    },
  });
}

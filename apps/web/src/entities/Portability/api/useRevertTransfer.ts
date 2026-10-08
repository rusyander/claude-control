import type { TransferPair } from './PortabilityApi.types';
import type { TransferRevertAnswer } from '@agentdeck/contracts/portable-transfer';
import { apiClient } from '@shared/api/client';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function postRevert(
  pair: TransferPair & { confirm: readonly string[] },
): Promise<TransferRevertAnswer> {
  const { data } = await apiClient.post<TransferRevertAnswer>('/portability/revert', pair);
  return data;
}

/**
 * Отмена переноса. `confirm` — файлы, которые человек правил после переноса и
 * всё же велел вернуть: без его слова они не трогаются.
 */
export function useRevertTransfer() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { silentError: true },
    mutationFn: postRevert,
    onSuccess: (_answer, variables) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.portabilityTransfer(
          variables.provider,
          variables.target,
          variables.scope,
          variables.project,
        ),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.portabilityFidelity(
          variables.provider,
          variables.target,
          variables.scope,
          variables.project,
        ),
      });
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

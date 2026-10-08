import type { TransferPair } from './PortabilityApi.types';
import type { TransferApplyAnswer } from '@agentdeck/contracts/portable-transfer';
import { apiClient } from '@shared/api/client';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function postApply(
  pair: TransferPair & { fingerprint: string },
): Promise<TransferApplyAnswer> {
  const { data } = await apiClient.post<TransferApplyAnswer>('/portability/apply', pair);
  return data;
}

/**
 * Применение плана. `fingerprint` — того плана, который человеку ПОКАЗАЛИ:
 * сервер сверяет его дважды и без показа отвечает 409.
 *
 * После успеха обновляется и след (появилась кнопка отмены), и отчёт верности:
 * файлы цели теперь другие, и прежний отчёт говорил бы о среде, которой уже нет.
 */
export function useApplyTransfer() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { silentError: true },
    mutationFn: postApply,
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
      // Паспорт ЦЕЛИ тоже устарел: в неё только что записали. Паспорт источника
      // перенос не трогает.
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

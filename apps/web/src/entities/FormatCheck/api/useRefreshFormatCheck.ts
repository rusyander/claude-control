import type { FormatCheckResponse } from '@agentdeck/contracts';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { refreshFormatCheck } from '../lib/refreshFormatCheck';

/** Кнопка «проверить сейчас»: единственный путь, который идёт в сеть синхронно. */
export function useRefreshFormatCheck() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { silentError: true },
    mutationFn: refreshFormatCheck,
    onSuccess: (report) => {
      queryClient.setQueryData<FormatCheckResponse>(queryKeys.formatCheck, {
        report,
        stale: false,
      });
    },
  });
}

import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { setRunning } from '../lib/setRunning';

export function useSetDlpRunning() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { silentError: true },
    mutationFn: setRunning,
    onSuccess: (info) => {
      queryClient.setQueryData(queryKeys.dlp, info);
      void queryClient.invalidateQueries({ queryKey: queryKeys.dlpJournal });
    },
  });
}

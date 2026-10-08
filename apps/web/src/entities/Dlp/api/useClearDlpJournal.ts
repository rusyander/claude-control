import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { clearJournal } from '../lib/clearJournal';

export function useClearDlpJournal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: clearJournal,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.dlpJournal }),
  });
}

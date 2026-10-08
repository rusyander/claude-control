import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { putClaudeMd } from '../lib/putClaudeMd';

export function useUpdateClaudeMd() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: putClaudeMd,
    onSuccess: () => {
      // Правки CLAUDE.md меняют и разбор правил, и обзор.
      void queryClient.invalidateQueries({ queryKey: queryKeys.claudeMd });
      void queryClient.invalidateQueries({ queryKey: queryKeys.rules });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    },
    meta: { successMessage: 'claudeMd.saved' },
  });
}

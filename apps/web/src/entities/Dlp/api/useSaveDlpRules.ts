import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { saveRules } from '../lib/saveRules';

export function useSaveDlpRules() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { silentError: true },
    mutationFn: saveRules,
    // Промис возвращается намеренно: страница сбрасывает черновик в своём
    // onSuccess, и к тому моменту в кеше уже должны лежать новые правила —
    // иначе черновик пересеялся бы старыми.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.dlp }),
  });
}

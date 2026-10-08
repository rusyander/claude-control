import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

/** Инвалидация после записи: список раздела + сводка на главной. */
export function useInvalidateProviderMcp() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.providerMcp });
    void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
  };
}

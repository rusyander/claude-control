import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

/** Инвалидация списка серверов проекта после любой правки. */
export function useInvalidateProviderProjectMcp(projectId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.projectProviderMcp(projectId) });
}

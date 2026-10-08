import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

/** Инвалидация списка прав проекта после любой правки. */
export function useInvalidatePermissions(projectId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.projectPermissions(projectId) });
}

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { apiClient } from '@shared/api/client';
import type { ResourceCatalogView } from '@agentdeck/contracts';
import { PENDING_POLL_MS } from './GroupMembersApi.constants';

/**
 * Каталог «Выбрать готовый»: общие скиллы, правила, хуки и утилиты, а с путём
 * проекта — ещё и его ресурсы. Описания докатываются тем же фоновым путём.
 */
export function useResourceCatalog(projectPath: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.groupResourceCatalog(projectPath ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<ResourceCatalogView>('/groups/resource-catalog', {
        params: projectPath ? { path: projectPath } : {},
      });
      return data;
    },
    enabled,
    retry: false,
    refetchInterval: (query) =>
      (query.state.data?.pending ?? []).length > 0 ? PENDING_POLL_MS : false,
  });
}

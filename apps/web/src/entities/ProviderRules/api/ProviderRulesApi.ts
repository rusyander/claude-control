import { useQuery } from '@tanstack/react-query';
import type { ProviderRulesInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import type { Scope } from './ProviderRulesApi.types';
import { basePath } from '../lib/basePath';
import { listKey } from '../lib/listKey';

/** Список правил каталога + игнорируемые Cursor файлы + путь каталога. */
export function useProviderRules({ projectId }: Scope = {}) {
  return useQuery({
    queryKey: listKey(projectId),
    queryFn: async (): Promise<ProviderRulesInfo> => {
      const { data } = await apiClient.get<ProviderRulesInfo>(basePath(projectId));
      return data;
    },
  });
}

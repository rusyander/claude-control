import { useQuery } from '@tanstack/react-query';
import type { ProviderPluginsInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import type { Scope } from './ProviderPluginsApi.types';
import { basePath } from '../lib/basePath';
import { infoKey } from '../lib/infoKey';

/** Файлы каталога + список npm-пакетов. Половины независимы (у каждой свой readOnly). */
export function useProviderPlugins({ projectId }: Scope = {}) {
  return useQuery({
    queryKey: infoKey(projectId),
    queryFn: async (): Promise<ProviderPluginsInfo> => {
      const { data } = await apiClient.get<ProviderPluginsInfo>(basePath(projectId));
      return data;
    },
  });
}

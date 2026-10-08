import { useQuery } from '@tanstack/react-query';
import type { ProviderInstructionsInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import type { Scope } from './ProviderInstructionsApi.types';
import { basePath } from '../lib/basePath';
import { listKey } from '../lib/listKey';

/** Список ссылок на файлы инструкций + метаданные конфигурации. */
export function useProviderInstructions({ projectId }: Scope = {}) {
  return useQuery({
    queryKey: listKey(projectId),
    queryFn: async (): Promise<ProviderInstructionsInfo> => {
      const { data } = await apiClient.get<ProviderInstructionsInfo>(basePath(projectId));
      return data;
    },
  });
}

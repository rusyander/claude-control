import { useQuery } from '@tanstack/react-query';
import type { ProviderSkillsInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import type { Scope } from './ProviderSkillsApi.types';
import { basePath } from '../lib/basePath';
import { infoKey } from '../lib/infoKey';

/** Список скиллов каталога + путь каталога и прочие каталоги загрузки. */
export function useProviderSkills({ projectId }: Scope = {}) {
  return useQuery({
    queryKey: infoKey(projectId),
    queryFn: async (): Promise<ProviderSkillsInfo> => {
      const { data } = await apiClient.get<ProviderSkillsInfo>(basePath(projectId));
      return data;
    },
  });
}

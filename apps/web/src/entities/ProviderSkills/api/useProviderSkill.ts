import type { Scope } from './ProviderSkillsApi.types';
import { useQuery } from '@tanstack/react-query';
import { skillKey } from '../lib/skillKey';
import type { ProviderSkill } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { basePath } from '../lib/basePath';

/** Один скилл целиком: поля шапки отдельно от markdown-тела. */
export function useProviderSkill(path: string | undefined, { projectId }: Scope = {}) {
  return useQuery({
    queryKey: skillKey(path ?? '', projectId),
    enabled: Boolean(path),
    queryFn: async (): Promise<ProviderSkill> => {
      const { data } = await apiClient.get<ProviderSkill>(`${basePath(projectId)}/skill`, {
        params: { path },
      });
      return data;
    },
  });
}

import type { Scope } from './ProviderRulesApi.types';
import { useQuery } from '@tanstack/react-query';
import { ruleKey } from '../lib/ruleKey';
import type { ProviderRule } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { basePath } from '../lib/basePath';

/** Одно правило: три поля frontmatter отдельно от markdown-тела. */
export function useProviderRule(path: string | undefined, { projectId }: Scope = {}) {
  return useQuery({
    queryKey: ruleKey(path ?? '', projectId),
    enabled: Boolean(path),
    queryFn: async (): Promise<ProviderRule> => {
      const { data } = await apiClient.get<ProviderRule>(`${basePath(projectId)}/rule`, {
        params: { path },
      });
      return data;
    },
  });
}

import { useQuery } from '@tanstack/react-query';
import type { ProviderHooksInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import type { Scope } from './ProviderHooksApi.types';
import { basePath } from '../lib/basePath';
import { infoKey } from '../lib/infoKey';

/** Оба события целиком плюс всё, что панель сохраняет только для чтения. */
export function useProviderHooks({ projectId }: Scope = {}) {
  return useQuery({
    queryKey: infoKey(projectId),
    queryFn: async (): Promise<ProviderHooksInfo> => {
      const { data } = await apiClient.get<ProviderHooksInfo>(basePath(projectId));
      return data;
    },
  });
}

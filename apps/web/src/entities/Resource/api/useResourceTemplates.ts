import type { ResourceKind } from './ResourceApi.types';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

export interface ResourceTemplate {
  id: string;
  title: string;
  description: string;
  fileCount: number;
  paths: string[];
}

/** Заготовки структуры для вида ресурса — их немного, кешируем надолго. */
export function useResourceTemplates(kind: ResourceKind) {
  return useQuery({
    queryKey: ['resources', kind, 'templates'],
    queryFn: async () => {
      const { data } = await apiClient.get<ResourceTemplate[]>(`/resources/${kind}/templates`);
      return data;
    },
    staleTime: Infinity,
  });
}

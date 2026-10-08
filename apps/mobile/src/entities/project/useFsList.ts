import type { DirEntry } from './api.types';
import type { UseQueryResult } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api/client';

export interface DirListing {
  path: string;
  parent?: string;
  entries: DirEntry[];
}

export function useFsList(path: string): UseQueryResult<DirListing> {
  return useQuery({
    queryKey: ['fs', 'list', path],
    queryFn: () => api.get<DirListing>('/fs/list', { path }),
    enabled: Boolean(path),
  });
}

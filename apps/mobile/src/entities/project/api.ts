import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../../shared/api/client';
import type { DirEntry } from './api.types';

export function useFsRoots(): UseQueryResult<DirEntry[]> {
  return useQuery({
    queryKey: ['fs', 'roots'],
    queryFn: () => api.get<DirEntry[]>('/fs/roots'),
    staleTime: 60_000,
  });
}

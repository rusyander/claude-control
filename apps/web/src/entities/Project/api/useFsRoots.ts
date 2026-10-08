import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { DirEntry } from './ProjectApi.types';

/** Точки входа обзора: домашняя папка и корни дисков. */
export function useFsRoots() {
  return useQuery({
    queryKey: ['fs', 'roots'],
    queryFn: async () => {
      const { data } = await apiClient.get<DirEntry[]>('/fs/roots');
      return data;
    },
    staleTime: Infinity,
  });
}

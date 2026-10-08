import { useQuery } from '@tanstack/react-query';
import { ROOT_KEY } from './ProjectFileApi.constants';
import { apiClient } from '@shared/api/client';
import type { ProjectCodeLayout } from '@agentdeck/contracts';

/**
 * Раскладка окна — одна на панель, поэтому и ключ запроса без пути проекта.
 * Ширина списка файлов настраивается один раз и ожидается в любом проекте.
 */
export function useProjectCodeLayout(isEnabled: boolean) {
  return useQuery({
    queryKey: [ROOT_KEY, 'layout'],
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectCodeLayout>('/project-files/layout');
      return data;
    },
    enabled: isEnabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

import { useQuery } from '@tanstack/react-query';
import { ROOT_KEY } from './ProjectFileApi.constants';
import { apiClient } from '@shared/api/client';
import type { ProjectFileChanges } from '@agentdeck/contracts';

/**
 * Что агент поменял в этом разговоре. Пока прогон идёт, ответ устаревает с
 * каждым ходом, поэтому свежесть здесь нулевая: список отметок в дереве обязан
 * догонять работу агента, а не показывать снимок на момент открытия окна.
 */
export function useProjectChanges(path: string | undefined, chatId: string | undefined) {
  return useQuery({
    queryKey: [ROOT_KEY, 'changes', path ?? '', chatId ?? ''],
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectFileChanges>('/project-files/changes', {
        params: { path, chatId },
      });
      return data;
    },
    enabled: Boolean(path),
    staleTime: 0,
  });
}

import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProjectCodeLayout } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { ROOT_KEY } from './ProjectFileApi.constants';

/** Ширину пишем по концу перетаскивания; ответ сервера уже обрезан по границам. */
export function useSaveProjectCodeLayout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (layout: ProjectCodeLayout) => {
      const { data } = await apiClient.put<ProjectCodeLayout>('/project-files/layout', layout);
      return data;
    },
    onSuccess: (layout) => {
      queryClient.setQueryData<ProjectCodeLayout>([ROOT_KEY, 'layout'], layout);
    },
    meta: { silentError: true },
  });
}

import { useQueryClient, useMutation } from '@tanstack/react-query';
import type {
  ProjectTestPlanBuildRequest,
  ProjectTestPlanPreview,
  ProjectTestPlan,
} from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Собрать план правилом: предпросмотр, а по `save` — сразу сохранение.
 *
 * Мутация, а не запрос, хотя предпросмотр ничего не меняет: он считается по
 * диффу рабочей копии и истории прогонов, то есть по состоянию МОМЕНТА, и
 * кэшировать его под ключом значило бы показывать вчерашний отбор сегодня.
 */
export function useBuildTestPlan(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (payload: ProjectTestPlanBuildRequest & { save?: boolean }) => {
      const { data } = await apiClient.post<{
        preview: ProjectTestPlanPreview;
        plan?: ProjectTestPlan;
        plans?: ProjectTestPlan[];
      }>('/project-tests/plan/build', { path, ...payload });
      return data;
    },
    onSuccess: (data) => {
      if (!data.plans) return;
      client.setQueryData(testKeys.plans(path), data.plans);
      void client.invalidateQueries({ queryKey: testKeys.view(path) });
    },
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProjectTestPlan,
  ProjectTestPlanBuildRequest,
  ProjectTestPlanPreview,
  ProjectTestPoint,
} from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Тест-планы и развёрнутые из них тест-поинты.
 *
 * План хранится файлом (`plans/<id>.plan.json`), а поинты не хранятся вовсе:
 * их считает сервер из кейсов, окружений и параметров в момент запроса. Поэтому
 * список поинтов — отдельный запрос, а не поле плана: он меняется от любой
 * правки кейса, и держать его в плане значило бы врать о размере работы.
 */

export function useTestPlans(path: string | undefined, isEnabled = true) {
  return useQuery({
    queryKey: testKeys.plans(path),
    queryFn: async () => {
      const { data } = await apiClient.get<{ plans: ProjectTestPlan[] }>('/project-tests/plans', {
        params: { path },
      });
      return data.plans;
    },
    enabled: Boolean(path) && isEnabled,
  });
}

/** Общая часть правок плана: ответ сервера — новый список планов целиком. */
function usePlanMutation<TVariables>(
  path: string | undefined,
  send: (variables: TVariables) => Promise<ProjectTestPlan[]>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (plans) => {
      client.setQueryData(testKeys.plans(path), plans);
      // Список кейсов держит планы в своём ответе, а число поинтов считается по
      // плану — обе ветки после правки устарели.
      void client.invalidateQueries({ queryKey: testKeys.view(path) });
      void client.invalidateQueries({ queryKey: testKeys.points(path, undefined) });
    },
  });
}

export function useSaveTestPlan(path: string | undefined) {
  return usePlanMutation(path, async (plan: ProjectTestPlan) => {
    const { data } = await apiClient.post<{ plans: ProjectTestPlan[] }>('/project-tests/plan', {
      path,
      plan,
    });
    return data.plans;
  });
}

export function useRemoveTestPlan(path: string | undefined) {
  return usePlanMutation(path, async (id: string) => {
    const { data } = await apiClient.delete<{ plans: ProjectTestPlan[] }>('/project-tests/plan', {
      params: { path, id },
    });
    return data.plans;
  });
}

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

/** Во что план разворачивается: кейс × окружение × набор параметров. */
export function useTestPlanPoints(
  path: string | undefined,
  planId: string | undefined,
  environmentId?: string,
) {
  return useQuery({
    queryKey: testKeys.points(path, planId, environmentId),
    queryFn: async () => {
      const { data } = await apiClient.get<{ points: ProjectTestPoint[] }>(
        '/project-tests/plan/points',
        { params: { path, id: planId, environmentId: environmentId || undefined } },
      );
      return data.points;
    },
    enabled: Boolean(path) && Boolean(planId),
  });
}

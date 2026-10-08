import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { ProjectRunnerInfo } from '@agentdeck/contracts';
import { describeKey } from '../lib/describeKey';

/**
 * Общий хук для маршрутов, отвечающих обновлённым описанием целей: ответ кладём
 * прямо в кэш `describe`, чтобы поповер перерисовался без второго запроса.
 */
export function useRunnerInfoMutation<TVariables extends { path: string }>(
  url: string,
  body: (variables: TVariables) => Record<string, unknown>,
  /** Отказ показывает вызов сам — общий тост промолчит. */
  silentError = false,
) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError },
    mutationFn: async (variables: TVariables) => {
      const { data } = await apiClient.post<ProjectRunnerInfo>(url, body(variables));
      return data;
    },
    onSuccess: (info, { path }) => {
      queryClient.setQueryData(describeKey(path), info);
    },
  });
}

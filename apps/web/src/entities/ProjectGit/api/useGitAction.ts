import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { ProjectGitResult } from '@agentdeck/contracts';
import { keyFor } from '../lib/keyFor';

/** Общая обвязка операции записи: ответ кладём в кэш как новое состояние. */
export function useGitAction<TBody extends { path: string }>(url: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: TBody) => {
      const { data } = await apiClient.post<ProjectGitResult>(url, body);
      return data;
    },
    onSuccess: (result, body) => {
      queryClient.setQueryData(keyFor(body.path), result.info);
    },
  });
}

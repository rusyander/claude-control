import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { ProjectWorktreesResult } from '@agentdeck/contracts';
import { worktreesKeyFor } from '../lib/worktreesKeyFor';
import { keyFor } from '../lib/keyFor';

/**
 * Общая обвязка операций над копиями: ответ кладём в кэш как новый список, а
 * состояние самого репозитория помечаем устаревшим — набор веток после создания
 * копии другой, и селект переключения обязан это увидеть.
 */
export function useWorktreeAction<TBody extends { path: string }>(url: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Отказ показывает вызов своим тостом; общий из MutationCache встал бы
    // вторым, с сырым текстом сервера (живой прогон 26.09, F4).
    meta: { silentError: true },
    mutationFn: async (body: TBody) => {
      const { data } = await apiClient.post<ProjectWorktreesResult>(url, body);
      return data;
    },
    onSuccess: (result, body) => {
      queryClient.setQueryData(worktreesKeyFor(body.path), result.info);
      void queryClient.invalidateQueries({ queryKey: keyFor(body.path) });
    },
  });
}

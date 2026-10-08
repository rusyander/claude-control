import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { GroupKey } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { invalidateAfterWrite } from '../lib/invalidateAfterWrite';
import { queryKeys } from '@shared/api/query-keys';

export function useSetProjectGroupChoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { path: string; groupKey: GroupKey }) => {
      await apiClient.put('/projects/group-choice', input);
    },
    // Выбор одной пары меняет `choices` всех видов проекта. Мутация ждёт их
    // перечитывания: пока оно идёт, переключатель занят, а не показывает старое.
    onSuccess: async (_data, input) => {
      invalidateAfterWrite(queryClient);
      await queryClient.invalidateQueries({ queryKey: queryKeys.groupChoicesOf(input.path) });
    },
    meta: { successMessage: 'toasts.updated' },
  });
}

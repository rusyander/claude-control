import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Hook, HookDraft } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { createEntityApi } from '@shared/api/create-entity-api';
import { queryKeys } from '@shared/api/query-keys';

export const hookApi = createEntityApi<Hook, HookDraft>({
  resource: 'hooks',
  listKey: queryKeys.hooks,
  kind: 'hook',
});

/** Переставить хук вверх/вниз среди хуков того же события. */
export function useMoveHook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; direction: 'up' | 'down' }) => {
      await apiClient.post(`/hooks/${encodeURIComponent(input.id)}/move`, {
        direction: input.direction,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.hooks });
    },
    meta: { successMessage: 'toasts.moved' },
  });
}

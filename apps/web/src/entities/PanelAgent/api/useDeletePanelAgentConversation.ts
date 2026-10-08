import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/** Удалить разговор из истории; список перечитывается. Идущий ход сервер не даёт удалить (409). */
export function useDeletePanelAgentConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/agent/conversations/${encodeURIComponent(id)}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.panelAgentConversations }),
  });
}

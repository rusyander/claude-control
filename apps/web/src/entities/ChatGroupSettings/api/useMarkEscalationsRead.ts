import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { params } from '../lib/params';
import { queryKeys } from '@shared/api/query-keys';

export function useMarkEscalationsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { chatId: string; sessionId?: string }) => {
      await apiClient.post(
        `/chat/${encodeURIComponent(input.chatId)}/escalations/read`,
        {},
        { params: params(input.sessionId) },
      );
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.chatEscalations }),
  });
}

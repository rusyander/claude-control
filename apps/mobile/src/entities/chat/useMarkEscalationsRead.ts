import { useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '../../shared/api/client';

export function useMarkEscalationsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, sessionId }: { chatId: string; sessionId?: string }) =>
      api.post(
        `/chat/${encodeURIComponent(chatId)}/escalations/read` +
          (sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''),
        {},
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ['chat-escalations'] }),
  });
}

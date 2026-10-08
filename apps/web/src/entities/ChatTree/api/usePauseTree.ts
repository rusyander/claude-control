import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { ChatTreePaused } from '@agentdeck/contracts/chat-handoff';

export function usePauseTree() {
  return useMutation({
    mutationFn: async (chatId: string) => {
      const { data } = await apiClient.post<ChatTreePaused>(
        `/chat/${encodeURIComponent(chatId)}/tree/pause`,
      );
      return data;
    },
  });
}

import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { ChatTreeResumed } from '@agentdeck/contracts/chat-handoff';

export function useResumeTree() {
  return useMutation({
    mutationFn: async (chatId: string) => {
      const { data } = await apiClient.post<ChatTreeResumed>(
        `/chat/${encodeURIComponent(chatId)}/tree/resume`,
      );
      return data;
    },
  });
}

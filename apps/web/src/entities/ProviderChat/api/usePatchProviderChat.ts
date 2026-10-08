import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { ProviderChatSummary } from '@agentdeck/contracts';
import { providerChatKeys } from './ProviderChatApi.constants';

export function usePatchProviderChat() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      chatId: string;
      title?: string;
      workdir?: string;
      allowEdits?: boolean;
    }) => {
      const { chatId, ...patch } = input;
      const { data } = await apiClient.patch<ProviderChatSummary>(
        `/provider-chat/chats/${chatId}`,
        patch,
      );
      return data;
    },
    onSuccess: (chat) => {
      void queryClient.invalidateQueries({ queryKey: providerChatKeys.list });
      void queryClient.invalidateQueries({ queryKey: providerChatKeys.detail(chat.id) });
    },
  });
}

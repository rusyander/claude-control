import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { providerChatKeys } from './ProviderChatApi.constants';

export function useDeleteProviderChat() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { silentError: true },
    mutationFn: async (chatId: string) => {
      await apiClient.delete(`/provider-chat/chats/${chatId}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: providerChatKeys.list });
    },
  });
}

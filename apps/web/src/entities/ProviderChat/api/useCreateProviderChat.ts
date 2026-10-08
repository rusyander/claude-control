import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { ProviderChatSummary } from '@agentdeck/contracts';
import { providerChatKeys } from './ProviderChatApi.constants';

export function useCreateProviderChat() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { title?: string; workdir?: string } = {}) => {
      const { data } = await apiClient.post<ProviderChatSummary>('/provider-chat/chats', input);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: providerChatKeys.list });
      // Разговор в каталоге проекта добавляет проекту бейдж провайдера.
      void queryClient.invalidateQueries({ queryKey: providerChatKeys.projects });
    },
  });
}

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ProviderChatSummary } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';
import { foreignKeys } from './api.constants';

/** Новый разговор активного CLI. */
export function useCreateForeignChat(): ReturnType<
  typeof useMutation<ProviderChatSummary, Error, { workdir?: string }>
> {
  const client = useQueryClient();
  return useMutation<ProviderChatSummary, Error, { workdir?: string }>({
    mutationFn: (body) => api.post<ProviderChatSummary>('/provider-chat/chats', body),
    onSuccess: () => void client.invalidateQueries({ queryKey: foreignKeys.all }),
  });
}

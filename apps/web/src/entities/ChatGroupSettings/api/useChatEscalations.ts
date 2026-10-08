import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { apiClient } from '@shared/api/client';
import type { ChatEscalationsView } from '@agentdeck/contracts/chat-group-settings';

export function useChatEscalations() {
  return useQuery({
    queryKey: queryKeys.chatEscalations,
    queryFn: async () => {
      const { data } = await apiClient.get<ChatEscalationsView>('/chat/escalations');
      return data;
    },
  });
}

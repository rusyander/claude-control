import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

export function useArtifactSource(chatId: string | undefined, name: string | undefined) {
  return useQuery({
    queryKey: ['chats', chatId, 'artifact', name],
    queryFn: async () => {
      const { data } = await apiClient.get<{ content: string }>(`/chat/${chatId}/artifact`, {
        params: { name },
      });
      return data.content;
    },
    enabled: Boolean(chatId && name),
  });
}

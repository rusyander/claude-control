import { useQuery } from '@tanstack/react-query';
import { chatKeys } from './ChatApi.constants';
import { apiClient } from '@shared/api/client';
import type { Artifact } from '@agentdeck/contracts';

/** Файлы, созданные Claude в папке чата. */
export function useArtifacts(chatId: string | undefined) {
  return useQuery({
    queryKey: chatKeys.artifacts(chatId ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<Artifact[]>(`/chat/${chatId}/artifacts`);
      return data;
    },
    enabled: Boolean(chatId),
  });
}

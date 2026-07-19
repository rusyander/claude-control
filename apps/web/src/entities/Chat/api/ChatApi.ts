import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Artifact, ChatMessage, ChatSummary } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';

export const chatKeys = {
  list: ['chats'] as const,
  messages: (id: string) => ['chats', id, 'messages'] as const,
  artifacts: (id: string) => ['chats', id, 'artifacts'] as const,
};

/** Список разговоров. Читается из транскриптов Claude Code. */
export function useChats() {
  return useQuery({
    queryKey: chatKeys.list,
    queryFn: async () => {
      const { data } = await apiClient.get<ChatSummary[]>('/chats', { timeout: 120_000 });
      return data;
    },
  });
}

export function useChatMessages(chatId: string | undefined) {
  return useQuery({
    queryKey: chatKeys.messages(chatId ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<ChatMessage[]>(`/chats/${chatId}/messages`, {
        timeout: 120_000,
      });
      return data;
    },
    enabled: Boolean(chatId),
  });
}

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

/** Адрес файла для встроенного просмотра: картинки и документы браузер тянет сам. */
export function artifactUrl(chatId: string, name: string): string {
  return `${apiClient.defaults.baseURL}/chat/${chatId}/artifact?name=${encodeURIComponent(name)}`;
}

export function useRefreshChat(chatId: string | undefined) {
  const queryClient = useQueryClient();

  return (): void => {
    void queryClient.invalidateQueries({ queryKey: chatKeys.list });
    if (!chatId) return;
    void queryClient.invalidateQueries({ queryKey: chatKeys.messages(chatId) });
    void queryClient.invalidateQueries({ queryKey: chatKeys.artifacts(chatId) });
  };
}

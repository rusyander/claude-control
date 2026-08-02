import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProviderChatDetail,
  ProviderChatEvent,
  ProviderChatMessage,
  ProviderChatStatus,
  ProviderChatSummary,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';

/**
 * Переписка с чужим провайдером. Отдельный набор маршрутов, не пересекающийся с
 * чатом Claude: там источник правды — транскрипты самого CLI, здесь переписку
 * ведёт панель, потому что своей читаемой истории у этих CLI нет.
 */

export const providerChatKeys = {
  list: ['provider-chats'] as const,
  detail: (id: string) => ['provider-chats', id] as const,
};

export function useProviderChats(enabled = true) {
  return useQuery({
    queryKey: providerChatKeys.list,
    queryFn: async () => {
      const { data } = await apiClient.get<ProviderChatSummary[]>('/provider-chat/chats');
      return data;
    },
    enabled,
  });
}

export function useProviderChat(chatId: string | undefined) {
  return useQuery({
    queryKey: providerChatKeys.detail(chatId ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<ProviderChatDetail>(`/provider-chat/chats/${chatId}`);
      return data;
    },
    enabled: Boolean(chatId),
  });
}

export function useCreateProviderChat() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { title?: string; workdir?: string } = {}) => {
      const { data } = await apiClient.post<ProviderChatSummary>('/provider-chat/chats', input);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: providerChatKeys.list });
    },
  });
}

export function usePatchProviderChat() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { chatId: string; title?: string; workdir?: string }) => {
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

export function useDeleteProviderChat() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (chatId: string) => {
      await apiClient.delete(`/provider-chat/chats/${chatId}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: providerChatKeys.list });
    },
  });
}

/** Задать вопрос. Ответ придёт потоком — здесь возвращается записанная реплика. */
export async function sendProviderChatMessage(
  chatId: string,
  input: { text: string; attachments?: string[] },
): Promise<ProviderChatMessage> {
  const { data } = await apiClient.post<{ message: ProviderChatMessage }>(
    `/provider-chat/chats/${chatId}/send`,
    input,
  );
  return data.message;
}

export async function stopProviderChat(chatId: string): Promise<void> {
  await apiClient.post(`/provider-chat/chats/${chatId}/stop`);
}

/** Что происходит прямо сейчас — этим вкладка догоняет пропущенное после F5. */
export async function readProviderChatStatus(chatId: string): Promise<ProviderChatStatus> {
  const { data } = await apiClient.get<ProviderChatStatus>(`/provider-chat/chats/${chatId}/status`);
  return data;
}

/**
 * Поток ответа. Читается вручную, а не `EventSource`: у того нет ни отмены по
 * сигналу, ни собственного переподключения под наши правила — а рвать поток при
 * уходе со страницы нужно точно и сразу.
 *
 * Пинг-комментарии (`: ping`) пропускаются: они держат соединение живым, пока
 * CLI думает над первым словом, и событиями не являются.
 */
export async function openProviderChatStream(
  chatId: string,
  onEvent: (event: ProviderChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${apiClient.defaults.baseURL}/provider-chat/chats/${chatId}/stream`,
    { method: 'GET', signal },
  );
  if (!response.ok || !response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;

    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const line = frame.split('\n').find((part) => part.startsWith('data:'));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as ProviderChatEvent);
      } catch {
        // Неразборный кадр пропускаем: поток от этого рваться не должен.
      }
    }
  }
}

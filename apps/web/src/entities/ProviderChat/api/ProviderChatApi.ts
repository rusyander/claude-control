import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProviderChatDetail,
  ProviderChatEvent,
  ProviderChatMessage,
  ProviderChatProject,
  ProviderChatQueued,
  ProviderChatStatus,
  ProviderChatSummary,
} from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

/**
 * Переписка с чужим провайдером. Отдельный набор маршрутов, не пересекающийся с
 * чатом Claude: там источник правды — транскрипты самого CLI, здесь переписку
 * ведёт панель, потому что своей читаемой истории у этих CLI нет.
 */

export const providerChatKeys = {
  list: ['provider-chats'] as const,
  detail: (id: string) => ['provider-chats', id] as const,
  // Свой корень, а не `['provider-chats', 'projects']`: тот совпал бы с
  // карточкой разговора по id «projects».
  projects: ['provider-chat-projects'] as const,
};

/**
 * Проекты всех провайдеров одним списком (Claude по его транскриптам, чужие CLI
 * по разговорам панели) — склеивает сервер, здесь только запрос.
 */
export function useProviderChatProjects(enabled = true) {
  return useQuery({
    queryKey: providerChatKeys.projects,
    queryFn: async () => {
      const { data } = await apiClient.get<ProviderChatProject[]>('/provider-chat/projects');
      return data;
    },
    enabled,
  });
}

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

/**
 * Ответ панели на кнопку «Перезапустить сессию» у чужого CLI (Т7). Сессии у него
 * нет: `started` — заведён НОВЫЙ разговор, `requested` — файл-опора ещё не готов,
 * и вкладка отправляет просьбу его обновить обычным сообщением.
 */
export interface ProviderChatRestart {
  mode: 'started' | 'requested';
  chatId?: string;
  chainDepth?: number;
  prompt?: string;
}

export function useRestartProviderChat() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { silentError: true },
    mutationFn: async (chatId: string) => {
      const { data } = await apiClient.post<ProviderChatRestart>(
        `/provider-chat/chats/${chatId}/restart`,
      );
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: providerChatKeys.list });
    },
  });
}

/**
 * Задать вопрос. Ответ придёт потоком — здесь возвращается записанная реплика.
 * Разговор занят, а `queueIfBusy` — сервер ставит сообщение в очередь (202) и
 * возвращает её элемент: сообщение уйдёт само по концу идущего ответа. Если у
 * CLI есть вход посреди ответа (В1), реплику подхватывает идущий ход —
 * `{ message, steered: true }`.
 */
export async function sendProviderChatMessage(
  chatId: string,
  input: { text: string; attachments?: string[]; queueIfBusy?: boolean },
): Promise<{ message: ProviderChatMessage; steered?: true } | { queued: ProviderChatQueued }> {
  const { data } = await apiClient.post<
    { message: ProviderChatMessage; steered?: true } | { queued: ProviderChatQueued }
  >(`/provider-chat/chats/${chatId}/send`, input);
  return data;
}

/** Убрать сообщение из очереди; `false` — оно уже ушло. */
export async function cancelProviderChatQueued(chatId: string, queuedId: string): Promise<boolean> {
  const { data } = await apiClient.delete<{ cancelled: boolean }>(
    `/provider-chat/chats/${chatId}/queue/${queuedId}`,
  );
  return data.cancelled;
}

/**
 * «Отправить» у ждущей очереди (Ф13): ход остановили или панель
 * перезапускалась — сообщение уходит обычной отправкой.
 */
export async function sendProviderChatQueued(
  chatId: string,
  queuedId: string,
): Promise<{ message: ProviderChatMessage }> {
  const { data } = await apiClient.post<{ message: ProviderChatMessage }>(
    `/provider-chat/chats/${chatId}/queue/${queuedId}/send`,
  );
  return data;
}

/** Ответ человека на просьбу CLI о разрешении (карточка в ленте). */
export async function answerProviderChatPermission(
  chatId: string,
  askId: string,
  decision: 'allow' | 'deny',
): Promise<void> {
  await apiClient.post(`/provider-chat/chats/${chatId}/permissions/${askId}`, { decision });
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

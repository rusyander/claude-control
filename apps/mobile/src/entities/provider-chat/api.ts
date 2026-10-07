import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  ProviderChatDetail,
  ProviderChatStatus,
  ProviderChatSummary,
  ProvidersResponse,
} from '@agentdeck/contracts';
import { api } from '../../shared/api/client';
import { isConfigured } from '../../shared/api/connection';

/**
 * Разговоры с чужим CLI — те же маршруты `/provider-chat/*`, что у панели.
 * Своей ленты событий телефон не держит: пока ход идёт, он спрашивает состояние
 * (`/status` отдаёт уже напечатанное), как спрашивает `/chat/active` у Claude.
 * Ответ из памяти сервера, диск при этом не читается.
 */

/** Как часто спрашивать состояние идущего ответа. */
export const STATUS_POLL_MS = 1_500;
/** Список разговоров живёт дольше: новые появляются редко. */
const LIST_POLL_MS = 10_000;

export const foreignKeys = {
  all: ['provider-chat'] as const,
  list: (providerId: string) => ['provider-chat', providerId, 'list'] as const,
  chat: (providerId: string, chatId: string) => ['provider-chat', providerId, chatId] as const,
  status: (providerId: string, chatId: string) =>
    ['provider-chat', providerId, chatId, 'status'] as const,
};

/** Активный CLI панели и имена всех: по ним телефон решает, чей список показывать. */
export function useProviders(): UseQueryResult<ProvidersResponse> {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<ProvidersResponse>('/providers'),
    staleTime: 30_000,
    enabled: isConfigured(),
  });
}

/** Разговоры активного CLI. У Claude их нет — у него свой чат. */
export function useForeignChats(
  providerId: string | undefined,
): UseQueryResult<ProviderChatSummary[]> {
  return useQuery({
    queryKey: foreignKeys.list(providerId ?? ''),
    queryFn: () => api.get<ProviderChatSummary[]>('/provider-chat/chats'),
    enabled: isConfigured() && Boolean(providerId) && providerId !== 'claude',
    refetchInterval: LIST_POLL_MS,
  });
}

/**
 * Разговор целиком. `provider` уходит всегда: разговор, открытый по уведомлению,
 * мог принадлежать CLI, который уже не активен, — сервер отдаёт его на чтение.
 */
export function useForeignChat(
  providerId: string,
  chatId: string,
): UseQueryResult<ProviderChatDetail> {
  return useQuery({
    queryKey: foreignKeys.chat(providerId, chatId),
    queryFn: () =>
      api.get<ProviderChatDetail>(`/provider-chat/chats/${encodeURIComponent(chatId)}`, {
        provider: providerId,
      }),
    enabled: isConfigured() && Boolean(chatId),
  });
}

/** Состояние хода сейчас, без ожидания. */
export function fetchForeignStatus(chatId: string): Promise<ProviderChatStatus> {
  return api.get<ProviderChatStatus>(`/provider-chat/chats/${encodeURIComponent(chatId)}/status`);
}

/** Состояние хода: уже напечатанное, очередь, просьбы о разрешении. Только у активного CLI. */
export function useForeignStatus(
  providerId: string,
  chatId: string,
  enabled: boolean,
): UseQueryResult<ProviderChatStatus> {
  return useQuery({
    queryKey: foreignKeys.status(providerId, chatId),
    queryFn: () => fetchForeignStatus(chatId),
    enabled: isConfigured() && enabled && Boolean(chatId),
    // Ход идёт или ждёт человека — опрос частый; тишина — редкий, чтобы заметить
    // ход, начатый с компьютера.
    refetchInterval: (query) =>
      query.state.data?.isRunning || query.state.data?.permissions?.length
        ? STATUS_POLL_MS
        : LIST_POLL_MS,
    // В фоне опрос не прекращается: на нём держится уведомление «ответ готов»
    // (push до телефона не доходит, пока у приложения нет проекта EAS).
    refetchIntervalInBackground: true,
  });
}

/** Сколько сервер держит длинный опрос состояния (его предел — 25 с). */
const STATUS_WAIT_MS = 25_000;

/**
 * Состояние хода длинным опросом: сервер отвечает на конце хода или на новой
 * просьбе о разрешении. Для слежки в фоне, где таймеры спят.
 */
export function waitForeignStatus(chatId: string): Promise<ProviderChatStatus> {
  // Свой предел ожидания длиннее серверного: обычные 20 с оборвали бы опрос раньше ответа.
  return api.get<ProviderChatStatus>(
    `/provider-chat/chats/${encodeURIComponent(chatId)}/status`,
    { wait: STATUS_WAIT_MS },
    { timeoutMs: STATUS_WAIT_MS + 10_000 },
  );
}

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

/**
 * Вопрос. `queueIfBusy` — всегда: идёт ответ — слово уйдёт в него же, если CLI
 * это умеет, иначе дождётся конца в очереди сервера. Отказа «занято» телефон не
 * показывает: человек не за столом, чтобы отправить ещё раз.
 */
export function useSendForeign(
  providerId: string,
  chatId: string,
): ReturnType<typeof useMutation<unknown, Error, string>> {
  const client = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (text) =>
      api.post(`/provider-chat/chats/${encodeURIComponent(chatId)}/send`, {
        text,
        queueIfBusy: true,
      }),
    onSettled: () =>
      void client.invalidateQueries({ queryKey: foreignKeys.chat(providerId, chatId) }),
  });
}

export function useStopForeign(
  providerId: string,
  chatId: string,
): ReturnType<typeof useMutation<unknown, Error, void>> {
  const client = useQueryClient();
  return useMutation<unknown, Error, void>({
    mutationFn: () => api.post(`/provider-chat/chats/${encodeURIComponent(chatId)}/stop`),
    onSettled: () =>
      void client.invalidateQueries({ queryKey: foreignKeys.chat(providerId, chatId) }),
  });
}

/** Ответ на просьбу CLI о разрешении. Пропала (ход кончился) — сервер скажет 404 своим текстом. */
export function useAnswerForeignPermission(
  providerId: string,
  chatId: string,
): ReturnType<typeof useMutation<unknown, Error, { askId: string; decision: 'allow' | 'deny' }>> {
  const client = useQueryClient();
  return useMutation<unknown, Error, { askId: string; decision: 'allow' | 'deny' }>({
    mutationFn: ({ askId, decision }) =>
      api.post(
        `/provider-chat/chats/${encodeURIComponent(chatId)}/permissions/${encodeURIComponent(askId)}`,
        { decision },
      ),
    onSettled: () =>
      void client.invalidateQueries({ queryKey: foreignKeys.status(providerId, chatId) }),
  });
}

/** Отправить ждущую очередь, когда её некому отпустить (ответ остановили, панель перезапускалась). */
export function useSendQueuedForeign(
  chatId: string,
): ReturnType<typeof useMutation<unknown, Error, string>> {
  const client = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (queuedId) =>
      api.post(
        `/provider-chat/chats/${encodeURIComponent(chatId)}/queue/${encodeURIComponent(queuedId)}/send`,
      ),
    onSettled: () => void client.invalidateQueries({ queryKey: foreignKeys.all }),
  });
}

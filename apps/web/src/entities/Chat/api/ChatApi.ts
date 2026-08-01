import { useEffect, useRef } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Artifact,
  ChatMessagesPage,
  ChatProgress,
  ChatSearchResponse,
  ChatSummary,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';

/** Размер окна ленты и шаг подгрузки более ранних сообщений. */
export const CHAT_PAGE_SIZE = 400;

export const chatKeys = {
  list: ['chats'] as const,
  messages: (id: string) => ['chats', id, 'messages'] as const,
  artifacts: (id: string) => ['chats', id, 'artifacts'] as const,
  progress: (id: string) => ['chats', id, 'progress'] as const,
  /** Поиск по телу переписки: ключ зависит от запроса — кешируем по строке. */
  search: (query: string) => ['chats', 'search', query] as const,
  /** Отпечаток транскрипта: по нему видно, что разговор дописали. */
  version: (id: string) => ['chats', id, 'version'] as const,
};

/** Ниже этого порога поиск по телу не запускаем — совпадает с порогом на сервере. */
export const MIN_CHAT_SEARCH_LENGTH = 2;

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

/**
 * Полнотекстовый поиск по телу переписки. Запрос уходит на сервер, который
 * сканирует транскрипты и возвращает разговоры со сниппетом вокруг совпадения.
 * Слишком короткий запрос на сервер не шлём — он всё равно вернул бы пусто.
 */
export function useChatBodySearch(query: string) {
  const normalized = query.trim();
  const enabled = normalized.length >= MIN_CHAT_SEARCH_LENGTH;

  return useQuery({
    queryKey: chatKeys.search(normalized),
    queryFn: async () => {
      const { data } = await apiClient.get<ChatSearchResponse>('/chat/search', {
        params: { q: normalized },
        timeout: 120_000,
      });
      return data;
    },
    enabled,
    // Прежние совпадения держим на экране, пока грузятся новые — список не мигает
    // пустотой на каждый набранный символ.
    placeholderData: keepPreviousData,
  });
}

/**
 * Лента переписки окном. По умолчанию — последние `CHAT_PAGE_SIZE` сообщений;
 * увеличивая `limit` кнопкой «Загрузить ещё», подтягиваем более ранние. Прежнее
 * окно держим на экране, пока грузится расширенное, — лента не мигает пустотой.
 */
export function useChatMessages(chatId: string | undefined, limit = CHAT_PAGE_SIZE) {
  return useQuery({
    queryKey: [...chatKeys.messages(chatId ?? ''), limit] as const,
    queryFn: async () => {
      const { data } = await apiClient.get<ChatMessagesPage>(`/chats/${chatId}/messages`, {
        params: { limit },
        timeout: 120_000,
      });
      return data;
    },
    enabled: Boolean(chatId),
    placeholderData: keepPreviousData,
  });
}

/**
 * Держать открытый разговор в актуальном состоянии — без F5.
 *
 * Панель владеет не каждым прогоном: тот же чат идёт из терминала, из
 * расширения редактора, из соседнего окна панели. Своего потока событий в таком
 * разговоре нет, и до появления этой страховки лента показывала снимок на
 * момент открытия — вопрос агента человек видел только после перезагрузки
 * страницы.
 *
 * Дорог тут не опрос, а перечитывание ленты, поэтому спрашиваем отпечаток
 * (одна `stat` на сервере) и трогаем ленту, только когда он изменился. Второй,
 * более быстрый канал — `/api/events` от наблюдателя за файлами; этот работает
 * и тогда, когда наблюдение выключено тумблером или поток оборван.
 */
export function useChatAutoRefresh(chatId: string | undefined, isRunning: boolean): void {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: chatKeys.version(chatId ?? ''),
    queryFn: async () => {
      const { data: version } = await apiClient.get<{ mtimeMs: number; size: number }>(
        `/chats/${chatId}/version`,
      );
      return version;
    },
    enabled: Boolean(chatId),
    // Пока идёт свой прогон, лента и так живёт потоком, но чужой ход виден
    // только отсюда — опрашиваем чаще, стоит это одной `stat`.
    refetchInterval: isRunning ? 2000 : 5000,
    // Вкладку свернули — опрашивать некому и незачем; вернулись к ней —
    // спрашиваем сразу, не дожидаясь очередного такта.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  const stamp = data ? `${data.mtimeMs}:${data.size}` : undefined;
  const seen = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!chatId || !stamp) return;
    // Первый ответ — это то, что уже показано: перечитывать нечего.
    if (seen.current === undefined) {
      seen.current = stamp;
      return;
    }
    if (seen.current === stamp) return;
    seen.current = stamp;
    void queryClient.invalidateQueries({ queryKey: chatKeys.messages(chatId) });
    void queryClient.invalidateQueries({ queryKey: chatKeys.list });
  }, [chatId, stamp, queryClient]);

  // Смена разговора начинает счёт заново — иначе первый же отпечаток нового
  // чата выглядел бы изменением и дёргал ленту сразу после открытия.
  useEffect(() => {
    seen.current = undefined;
  }, [chatId]);
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

/**
 * Прогресс агента: его собственные чекпоинты и дерево субагентов. Источник —
 * транскрипт, поэтому данные есть и у вчерашнего разговора, а не только у
 * открытой вкладки. Пока агент работает, перечитываем раз в несколько секунд:
 * CLI дописывает транскрипт по ходу дела, и план обновляется почти сразу.
 */
export function useChatProgress(chatId: string | undefined, isRunning: boolean) {
  return useQuery({
    queryKey: chatKeys.progress(chatId ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<ChatProgress>(`/chat/${chatId}/progress`);
      return data;
    },
    enabled: Boolean(chatId),
    refetchInterval: isRunning ? 4000 : false,
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

/** Адрес выгрузки разговора файлом — по нему браузер скачивает Markdown/JSON. */
export function chatExportUrl(chatId: string, format: 'md' | 'json'): string {
  return `${apiClient.defaults.baseURL}/chat/${chatId}/export?format=${format}`;
}

/**
 * Удалить артефакт из папки чата. Доступно только у чатов песочницы: их файлы
 * лежат в отдельной папке панели, и убрать лишнее там безопасно. После удаления
 * перечитываем список артефактов.
 */
export function useDeleteArtifact(chatId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (name: string) => {
      await apiClient.delete(`/chat/${chatId}/artifact`, { params: { name } });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.artifacts(chatId ?? '') });
    },
  });
}

/**
 * Перечитать список и переписку чата.
 *
 * Идентификатор можно передать явно — это важно для нового чата: он живёт под
 * временным номером, пока Claude Code не выдаст настоящий, и обновлять после
 * этого нужно уже настоящий. Иначе переписка, прочитанная в момент, когда
 * транскрипт ещё дописывался, так и осталась бы пустой.
 */
export function useRefreshChat(chatId: string | undefined) {
  const queryClient = useQueryClient();

  return (id: string | undefined = chatId): void => {
    void queryClient.invalidateQueries({ queryKey: chatKeys.list });
    if (!id) return;
    void queryClient.invalidateQueries({ queryKey: chatKeys.messages(id) });
    void queryClient.invalidateQueries({ queryKey: chatKeys.artifacts(id) });
  };
}

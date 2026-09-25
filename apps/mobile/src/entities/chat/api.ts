import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type {
  ChatAutoModeView,
  ChatMessagesPage,
  ChatProgress,
  ChatSummary,
} from '@agentdeck/contracts';
import { api } from '../../shared/api/client';

/**
 * Разговоры и их содержимое. Источник — транскрипты самого Claude Code, поэтому
 * список одинаков в панели, в приложении и в терминале: своей базы нет ни у
 * кого, и расходиться нечему.
 */

/** Проект глазами чата: путь, имя и разговоры, которые в нём велись. */
export interface ProjectChats {
  path: string;
  name: string;
  exists: boolean;
  lastActivity: string;
  chats: {
    id: string;
    title: string;
    updatedAt: string;
    messageCount: number;
    messageCountPartial?: boolean;
    isSandbox: boolean;
  }[];
}

/** Разговоры, которые ждут ответа: по ним ставится жёлтая точка в списках. */
export type AwaitingChats = Record<string, boolean>;

const STALE_MS = 15_000;

export function useChats(): UseQueryResult<ChatSummary[]> {
  return useQuery({
    queryKey: ['chats'],
    queryFn: () => api.get<ChatSummary[]>('/chats'),
    staleTime: STALE_MS,
  });
}

export function useChatProjects(): UseQueryResult<ProjectChats[]> {
  return useQuery({
    queryKey: ['chats', 'projects'],
    queryFn: () => api.get<ProjectChats[]>('/chats/projects'),
    staleTime: STALE_MS,
  });
}

/**
 * Лента разговора. Отдаётся окнами с конца: транскрипт длинного разговора
 * весит мегабайты, и тянуть его целиком на телефон незачем.
 */
export function chatMessagesQuery(
  chatId: string,
  limit = 60,
): { queryKey: unknown[]; queryFn: () => Promise<ChatMessagesPage> } {
  return {
    queryKey: ['chat', chatId, 'messages', limit],
    queryFn: () =>
      api.get<ChatMessagesPage>(`/chats/${encodeURIComponent(chatId)}/messages`, { limit }),
  };
}

export function useChatMessages(chatId: string, limit = 60): UseQueryResult<ChatMessagesPage> {
  return useQuery({
    ...chatMessagesQuery(chatId, limit),
    enabled: Boolean(chatId) && !chatId.startsWith('new-'),
    staleTime: STALE_MS,
  });
}

/**
 * Авторежим прав этого чата глазами сервера: выбор чата, иначе глобальная
 * настройка панели. Без него переключатель показывал бы «вкл» из коробки, даже
 * когда в панели авторежим выключен, — телефон врал бы о том, что сейчас будет.
 */
export function chatAutoModeQuery(
  chatId: string,
  sessionId?: string,
): { queryKey: unknown[]; queryFn: () => Promise<ChatAutoModeView> } {
  return {
    queryKey: ['chat', chatId, 'auto-mode', sessionId ?? ''],
    queryFn: () =>
      api.get<ChatAutoModeView>(`/chat/${encodeURIComponent(chatId)}/auto-mode`, { sessionId }),
  };
}

export function useChatAutoMode(
  chatId: string,
  sessionId?: string,
): UseQueryResult<ChatAutoModeView> {
  return useQuery({
    ...chatAutoModeQuery(chatId, sessionId),
    enabled: Boolean(chatId),
    staleTime: STALE_MS,
  });
}

/**
 * Что показывает переключатель: выбор, сделанный здесь и ещё не отправленный,
 * иначе то, что решит сервер. Сервер ещё не ответил — «вкл», как у панели из
 * коробки.
 */
export function shownAutoMode(
  chosen: boolean | undefined,
  view: ChatAutoModeView | undefined,
): boolean {
  return chosen ?? view?.enabled ?? true;
}

/** План агента и дерево субагентов — read-only, из транскрипта. */
export function useChatProgress(chatId: string, isRunning: boolean): UseQueryResult<ChatProgress> {
  return useQuery({
    queryKey: ['chat', chatId, 'progress'],
    queryFn: () => api.get<ChatProgress>(`/chat/${encodeURIComponent(chatId)}/progress`),
    enabled: Boolean(chatId) && !chatId.startsWith('new-'),
    // Пока агент работает, план меняется — обновляем сами; после завершения он
    // застывает, и опрашивать его дальше значит будить сеть впустую.
    refetchInterval: isRunning ? 5_000 : false,
    staleTime: STALE_MS,
  });
}

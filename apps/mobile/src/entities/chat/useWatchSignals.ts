import type { UseQueryResult } from '@tanstack/react-query';
import type { ChatWatchSignalsResponse } from '@agentdeck/contracts/group-watch';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api/client';

/**
 * Сигналы сторожа для строк списка чатов (F7): одиночные чаты и группы разделения.
 * Рассылки у телефона нет — опрос раз в полминуты, как у заметок главному чату.
 * Модуль контрактов со схемами (zod) телефону значением не нужен: ответ уже разобран
 * сервером (`chatWatchSignalsOf`), здесь только тип.
 */
export const WATCH_SIGNALS_POLL_MS = 30_000;

export function useWatchSignals(): UseQueryResult<ChatWatchSignalsResponse> {
  return useQuery({
    queryKey: ['chat-watch-signals'],
    queryFn: () => api.get<ChatWatchSignalsResponse>('/chat/watch-signals'),
    refetchInterval: WATCH_SIGNALS_POLL_MS,
  });
}

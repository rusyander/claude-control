import type { UseQueryResult } from '@tanstack/react-query';
import type { ProviderChatStatus } from '@agentdeck/contracts';
import { useQuery } from '@tanstack/react-query';
import { foreignKeys, LIST_POLL_MS } from './api.constants';
import { fetchForeignStatus } from './fetchForeignStatus';
import { isConfigured } from '../../shared/api/connection';

/**
 * Разговоры с чужим CLI — те же маршруты `/provider-chat/*`, что у панели.
 * Своей ленты событий телефон не держит: пока ход идёт, он спрашивает состояние
 * (`/status` отдаёт уже напечатанное), как спрашивает `/chat/active` у Claude.
 * Ответ из памяти сервера, диск при этом не читается.
 */

/** Как часто спрашивать состояние идущего ответа. */
export const STATUS_POLL_MS = 1_500;

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

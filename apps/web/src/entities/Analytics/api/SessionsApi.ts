import { useMutation } from '@tanstack/react-query';
import type { SessionLocation } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { SESSION_TIMEOUT_MS } from './SessionsApi.constants';

/**
 * «Перейти» и «Остановить» у строки вкладки «Сессии». Где идёт сессия, сервер
 * выясняет по живым процессам — это не кэшируется: ответ нужен на момент клика.
 * Отказы показывает сама строка словами, поэтому общий тост хуки глушат.
 */

/** Где идёт сессия: чат панели, процесс вне панели, неопознана или завершена. */
export function useLocateSession() {
  return useMutation({
    mutationFn: async (sessionId: string): Promise<SessionLocation> => {
      const { data } = await apiClient.get<SessionLocation>(
        `/analytics/sessions/${encodeURIComponent(sessionId)}/where`,
        { timeout: SESSION_TIMEOUT_MS },
      );
      return data;
    },
    meta: { silentError: true },
  });
}

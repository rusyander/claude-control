import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SessionLocation, SessionStopResult } from '@agentdeck/contracts';
import type { SessionStopBody } from '@agentdeck/contracts/request-bodies';
import { apiClient } from '@shared/api/client';

/** Обход процессов на Windows — PowerShell, секунды; общих 60 с не ждём. */
const SESSION_TIMEOUT_MS = 30_000;

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

/** Снять процесс сессии вне панели — ровно тот, что показан в окне подтверждения. */
export function useStopSessionProcess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      sessionId: string;
      body: SessionStopBody;
    }): Promise<SessionStopResult> => {
      const { data } = await apiClient.post<SessionStopResult>(
        `/analytics/sessions/${encodeURIComponent(input.sessionId)}/stop`,
        input.body,
        { timeout: SESSION_TIMEOUT_MS },
      );
      return data;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['analytics'] }),
    meta: { silentError: true },
  });
}

/** Стоп чата панели — тот же, что кнопкой «Стоп» в самом чате. */
export function useStopPanelChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (chatId: string): Promise<{ ok: boolean }> => {
      const { data } = await apiClient.post<{ ok: boolean }>(
        `/chat/${encodeURIComponent(chatId)}/stop`,
      );
      return data;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['analytics'] }),
    meta: { silentError: true },
  });
}

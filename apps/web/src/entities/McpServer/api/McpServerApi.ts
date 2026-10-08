import { useMutation } from '@tanstack/react-query';
import type { McpServer, McpServerDraft } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { createEntityApi } from '../../../shared/api/createEntityApi';

export const mcpServerApi = createEntityApi<McpServer, McpServerDraft>({
  resource: 'mcp',
  listKey: queryKeys.mcp,
  kind: 'mcp',
});

/**
 * Что вернул старт входа: `authorized` — сохранённый токен уже подошёл,
 * `not-required` — сервер ответил без входа вовсе (локальный Dev Mode Figma),
 * `redirect` — надо открыть адрес авторизации.
 */
export interface StartOAuthResult {
  status: 'authorized' | 'not-required' | 'redirect';
  authorizationUrl?: string;
}

/**
 * Начать интерактивный вход в MCP-сервер. Само окно авторизации открывает
 * карточка — синхронно по клику, иначе его срежет блокировщик всплывающих окон.
 * Здесь только запрос: он возвращает либо готовый статус, либо адрес для окна.
 */
export function useStartOAuth() {
  return useMutation({
    mutationFn: async (id: string): Promise<StartOAuthResult> => {
      const { data } = await apiClient.post<StartOAuthResult>(
        `/mcp/${encodeURIComponent(id)}/oauth/start`,
      );
      return data;
    },
    // Отказ карточка показывает сама, словами у кнопки — общий тост был бы вторым.
    meta: { silentError: true },
  });
}

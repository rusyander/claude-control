import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { McpServer, McpServerDraft, McpToolsResult } from '@claude-control/contracts';
import { createEntityApi } from '@shared/api/create-entity-api';
import { apiClient, LONG_TIMEOUTS } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { i18n } from '@shared/config/i18n';
import { toast } from '@shared/lib/toast';

export const mcpServerApi = createEntityApi<McpServer, McpServerDraft>({
  resource: 'mcp',
  listKey: queryKeys.mcp,
  kind: 'mcp',
});

/** Что вернул старт входа: токен уже есть или надо открыть адрес авторизации. */
export interface StartOAuthResult {
  status: 'authorized' | 'redirect';
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
  });
}

/**
 * Список инструментов сервера для помощника отбора прав. Сервер поднимается и
 * опрашивается по протоколу — как проверка связи, но возвращаются сами имена.
 * Ждём дольше обычного: у stdio в рукопожатие входит запуск процесса.
 *
 * Бюджет тот же, что у проверки связи: серверный `listMcpServerTools` считает
 * потолок по той же формуле, что и `checkMcpHealth` (до ~180 c при большом
 * mcpNetworkTimeoutMs). Своих 120 c здесь не хватало — медленный сервер рвался
 * на клиенте ложным таймаутом, пока серверная сторона спокойно ждала ответа.
 */
export function useMcpServerTools() {
  return useMutation({
    mutationFn: async (id: string): Promise<McpToolsResult> => {
      const { data } = await apiClient.post<McpToolsResult>(
        `/mcp/${encodeURIComponent(id)}/tools`,
        undefined,
        { timeout: LONG_TIMEOUTS.mcpHealth },
      );
      return data;
    },
  });
}

/** Забыть авторизацию сервера — удалить сохранённый токен. */
export function useClearOAuth() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await apiClient.delete(`/mcp/${encodeURIComponent(id)}/oauth`);
    },
    onSuccess: () => {
      toast.success(i18n.t('mcp.oauthCleared'));
      void queryClient.invalidateQueries({ queryKey: queryKeys.mcp });
    },
  });
}

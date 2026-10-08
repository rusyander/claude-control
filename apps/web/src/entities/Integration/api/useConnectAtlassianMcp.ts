import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { integrationKeys } from './keys';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Собственный MCP-сервер панели над Atlassian: регистрация — действие ЧЕЛОВЕКА.
 * Автоматически панель чужой CLI не переписывает, поэтому это кнопка, а не
 * следствие включённого коннектора.
 */
export function useConnectAtlassianMcp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (isConnected: boolean): Promise<void> => {
      if (isConnected) await apiClient.delete('/integrations/mcp/connect');
      else await apiClient.post('/integrations/mcp/connect', {});
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: integrationKeys.root });
      void client.invalidateQueries({ queryKey: queryKeys.mcp });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}

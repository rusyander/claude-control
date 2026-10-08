import { useMutation } from '@tanstack/react-query';
import type { McpToolsResult } from '@agentdeck/contracts';
import { apiClient, LONG_TIMEOUTS } from '@shared/api/client';

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

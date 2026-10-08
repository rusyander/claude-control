import type { McpToolDetail } from '@agentdeck/contracts';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

/**
 * Инструмент MCP в песочнице — контрактная форма `McpToolDetail`: имя, описание
 * и схема параметров. Имя оставлено прежним: под ним он ходит по интерфейсу.
 */
export type McpTool = McpToolDetail;

export function useMcpTools() {
  return useMutation({
    mutationFn: async (mcpId: string) => {
      const { data } = await apiClient.post<{ tools: McpTool[]; error?: string }>(
        '/sandbox/mcp-tools',
        { mcpId },
        { timeout: 120_000 },
      );
      return data;
    },
  });
}

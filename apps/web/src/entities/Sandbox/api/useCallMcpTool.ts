import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

export function useCallMcpTool() {
  return useMutation({
    mutationFn: async (input: { mcpId: string; tool: string; args: Record<string, unknown> }) => {
      const { data } = await apiClient.post<{
        ok: boolean;
        content: string;
        isError: boolean;
        durationMs: number;
      }>('/sandbox/mcp-call', input, { timeout: 120_000 });
      return data;
    },
  });
}

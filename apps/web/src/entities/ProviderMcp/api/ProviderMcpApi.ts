import { useQuery } from '@tanstack/react-query';
import type { ProviderMcpInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Универсальные MCP-серверы активного провайдера (Gemini/Codex). Отдельный от
 * Claude набор запросов: Claude MCP живёт на богатых роутах `/api/mcp` со своей
 * страницей — клиент выбирает набор по активному провайдеру. GET возвращает не
 * просто список, а `ProviderMcpInfo` (серверы + метаданные: формат, путь, найден
 * ли CLI, флаг readOnly), поэтому обычную фабрику сущностей здесь не используем.
 */

async function getProviderMcp(): Promise<ProviderMcpInfo> {
  const { data } = await apiClient.get<ProviderMcpInfo>('/provider-mcp');
  return data;
}

export function useProviderMcp() {
  return useQuery({ queryKey: queryKeys.providerMcp, queryFn: getProviderMcp });
}

import { useQuery } from '@tanstack/react-query';
import type { ProviderProjectInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Проектный уровень конфигурации у НЕ-Claude провайдеров (COMMON-2 + GEMINI-2/3).
 *
 * Claude остаётся на своих запросах (`ProjectConfigApi`: CLAUDE.md, .mcp.json,
 * права) — здесь универсальная ветка `/projects/:id/provider/*`: инструкции
 * проекта (AGENTS.md / GEMINI.md), MCP-серверы переносимого субсета, а у Gemini
 * ещё переменные окружения (`.gemini/.env`) и права (`.gemini/settings.json`) из
 * проектных файлов провайдера. Какие разделы есть у активного провайдера,
 * говорит сам сервер (`sections`), а не клиент: формат мы не угадываем.
 */

export function useProviderProject(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectProvider(projectId),
    queryFn: async () => {
      const { data } = await apiClient.get<ProviderProjectInfo>(`/projects/${projectId}/provider`);
      return data;
    },
    enabled: Boolean(projectId),
  });
}

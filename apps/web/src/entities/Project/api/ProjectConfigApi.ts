import { useQuery } from '@tanstack/react-query';
import type { ProjectRulesAnswer } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Конфиги конкретного проекта: его CLAUDE.md, MCP-серверы (.mcp.json) и права
 * (.claude/settings.json). На сервере они читаются и пишутся теми же доменными
 * функциями, что и пользовательский уровень, только с проектными путями.
 *
 * Проектная область — «сырое» чтение/правка файлов проекта: групп и
 * disabled-оверлеев пользовательского уровня здесь нет.
 */

// --- Правила проекта: CLAUDE.md целиком ---

export function useProjectRules(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectRules(projectId),
    queryFn: async () => {
      // Не только текст: имя файла правил решается ключом `instructionFiles`, и
      // экран обязан назвать, какой файл читает CLI (П2.7).
      const { data } = await apiClient.get<ProjectRulesAnswer>(`/projects/${projectId}/rules`);
      return data;
    },
    enabled: Boolean(projectId),
  });
}

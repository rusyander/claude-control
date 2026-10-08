import type { PathResourceType, ResourceSummary } from '@agentdeck/contracts';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { apiClient } from '@shared/api/client';

/**
 * Сводка ресурса «что делает / как работает». Зовётся лениво — только когда
 * строку раскрыли или участник показан: промах кэша стоит серверу вызова модели.
 */
export function useResourceSummary(
  type: PathResourceType,
  id: string,
  enabled = true,
  /** Проект, где лежит ресурс; нет — общие каталоги. */
  project?: string,
) {
  return useQuery({
    // Проект — часть ключа: одноимённые ресурсы проекта и общий — разные файлы.
    queryKey: [...queryKeys.resourceSummary(type, id), project ?? ''],
    queryFn: async () => {
      const { data } = await apiClient.get<ResourceSummary>('/resources/summary', {
        params: { type, id, ...(project ? { path: project } : {}) },
      });
      return data;
    },
    enabled,
    // Сводка меняется только вместе с файлом, а файл — редко: не переспрашиваем.
    staleTime: Infinity,
    retry: false,
  });
}

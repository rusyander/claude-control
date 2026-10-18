import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LocalLayerMode, LocalLayerStatus } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Локальный слой проекта: командный слой, собранный копией в
 * `.agent/local-layer/` и подключаемый к чатам панели вместо самого командного.
 * Чтение собирает слой заново, если командные файлы изменились, — тот же путь,
 * что у старта чата, поэтому карточка показывает ровно то, с чем уйдёт прогон.
 */

export function useProjectLocalLayer(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectLocalLayer(projectId),
    queryFn: async () => {
      const { data } = await apiClient.get<LocalLayerStatus>(`/projects/${projectId}/local-layer`);
      return data;
    },
    enabled: Boolean(projectId),
  });
}

/** Режим слоя; первый выбор создаёт `layer.json` и с ним сам слой. */
export function useSetLocalLayerMode(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (mode: LocalLayerMode) => {
      const { data } = await apiClient.put<LocalLayerStatus>(`/projects/${projectId}/local-layer`, {
        mode,
      });
      return data;
    },
    onSuccess: (data) => client.setQueryData(queryKeys.projectLocalLayer(projectId), data),
    meta: { successMessage: 'toasts.updated' },
  });
}

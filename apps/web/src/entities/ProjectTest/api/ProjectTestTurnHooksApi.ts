import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectTestTurnHooks } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Проверка конца хода агента в проекте — хуки панели в
 * `.claude/settings.local.json`. Их видят все чаты проекта: панели, VS Code,
 * терминала. Ставятся сами при добавлении проекта; здесь — посмотреть и выключить.
 */
export function useTestTurnHooks(path: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: testKeys.turnHooks(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestTurnHooks>('/project-tests/turn-hooks', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path) && enabled,
  });
}

export function useSetTestTurnHooks(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (enabledHooks: boolean) => {
      const { data } = await apiClient.put<ProjectTestTurnHooks>('/project-tests/turn-hooks', {
        path,
        enabled: enabledHooks,
      });
      return data;
    },
    onSuccess: (data) => client.setQueryData(testKeys.turnHooks(path), data),
  });
}

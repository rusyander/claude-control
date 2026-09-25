import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SplitDefaults, SplitDefaultsView } from '@agentdeck/contracts/split-groups';
import { apiClient } from '@shared/api/client';
import { projectGitKey } from './ProjectGitApi';

/**
 * Общие правила групп разделения — вкладка «Группы» в настройках: что группа
 * решает сама, сколько групп разом на лёгком и тяжёлом проекте и что считать
 * тяжёлым. Проект их наследует (`useSplitSettings`), пока не переопределит.
 */
const splitDefaultsKey = [...projectGitKey, 'split-defaults'] as const;

export function useSplitDefaults() {
  return useQuery({
    queryKey: splitDefaultsKey,
    queryFn: async () => {
      const { data } = await apiClient.get<SplitDefaultsView>('/split-defaults');
      return data;
    },
  });
}

export function useSaveSplitDefaults() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (body: SplitDefaults) => {
      const { data } = await apiClient.put<SplitDefaultsView>('/split-defaults', body);
      return data;
    },
    onSuccess: (result) => {
      queryClient.setQueryData(splitDefaultsKey, result);
      // Проекты без своего числа и строк берут их из общих — их ответы устарели.
      void queryClient.invalidateQueries({ queryKey: [...projectGitKey, 'split-settings'] });
    },
  });
}

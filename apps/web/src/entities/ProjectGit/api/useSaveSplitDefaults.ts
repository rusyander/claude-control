import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { SplitDefaults, SplitDefaultsView } from '@agentdeck/contracts/split-groups';
import { apiClient } from '@shared/api/client';
import { splitDefaultsKey } from './SplitDefaultsApi.constants';
import { projectGitKey } from './ProjectGitApi.constants';

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

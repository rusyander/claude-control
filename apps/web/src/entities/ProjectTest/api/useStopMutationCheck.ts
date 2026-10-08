import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { ProjectTestMutationView } from '@agentdeck/contracts';
import { testKeys } from './keys';

export function useStopMutationCheck(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<ProjectTestMutationView>(
        '/project-tests/mutation/stop',
        { path },
      );
      return data;
    },
    // Отказ карточка показывает строкой под кнопкой — общий тост был бы вторым.
    meta: { silentError: true },
    onSuccess: (data) => client.setQueryData(testKeys.mutation(path), data),
  });
}

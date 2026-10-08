import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProjectTestMutationMode, ProjectTestMutationView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

export function useStartMutationCheck(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { file: string; mode: ProjectTestMutationMode }) => {
      const { data } = await apiClient.post<ProjectTestMutationView>('/project-tests/mutation', {
        path,
        ...input,
      });
      return data;
    },
    // Отказ карточка показывает строкой под кнопкой — общий тост был бы вторым.
    meta: { silentError: true },
    onSuccess: (data) => client.setQueryData(testKeys.mutation(path), data),
  });
}

import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProjectTestBulkInput, ProjectTestsView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Массовое действие над отмеченными кейсами. Ответ шире обычного (`touched` —
 * сколько кейсов задето), поэтому мутация своя, а не через `useViewMutation`.
 */
export function useBulkTestCases(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (payload: ProjectTestBulkInput) => {
      const { data } = await apiClient.post<{ touched: number; view: ProjectTestsView }>(
        '/project-tests/bulk',
        { path, ...payload },
      );
      return data;
    },
    onSuccess: (data) => {
      client.setQueryData(testKeys.view(path), data.view);
      void client.invalidateQueries({ queryKey: testKeys.report(path) });
    },
  });
}

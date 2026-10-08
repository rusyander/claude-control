import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Принять свежий снимок эталоном.
 *
 * Отдельным действием и только руками: автоматическое принятие превращает
 * сверку в её отсутствие — любое расхождение молча становится новой нормой.
 */
export function useAcceptBaseline(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { caseId: string; pointId: string }): Promise<void> => {
      await apiClient.post('/project-tests/baseline/accept', { path, ...payload });
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: testKeys.root }),
    meta: { successMessage: 'tests.baseline.accepted' },
  });
}

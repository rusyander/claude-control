import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { ProjectTestDefectDraft } from '@agentdeck/contracts';

/** Черновик дефекта по провалу: заголовок и тело собирает сервер из кейса. */
export function useTestDefectDraft(path: string | undefined) {
  return useMutation({
    mutationFn: async (payload: { groupId: string; caseId: string; runId?: string }) => {
      const { data } = await apiClient.post<{ draft: ProjectTestDefectDraft }>(
        '/project-tests/defect',
        { path, ...payload },
      );
      return data.draft;
    },
  });
}

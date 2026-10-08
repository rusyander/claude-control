import { useDraftMutation } from './useDraftMutation';
import { apiClient } from '@shared/api/client';
import type { ProjectTestDraft, ProjectTestsView } from '@agentdeck/contracts';

/** Отклонить черновик: он уезжает в архив, библиотека не меняется. */
export function useRejectTestDraft(path: string | undefined, runId: string | undefined) {
  return useDraftMutation(path, runId, async () => {
    const { data } = await apiClient.post<{ draft: ProjectTestDraft; view: ProjectTestsView }>(
      '/project-tests/draft/reject',
      { path, runId },
    );
    return data;
  });
}

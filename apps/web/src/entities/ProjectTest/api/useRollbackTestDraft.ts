import { useDraftMutation } from './useDraftMutation';
import { apiClient } from '@shared/api/client';
import type { ProjectTestDraftRollbackResult, ProjectTestsView } from '@agentdeck/contracts';

/** Отменить приёмку: добавленное убрать, изменённое вернуть из снимка. */
export function useRollbackTestDraft(path: string | undefined, runId: string | undefined) {
  return useDraftMutation(path, runId, async () => {
    const { data } = await apiClient.post<
      ProjectTestDraftRollbackResult & { view: ProjectTestsView }
    >('/project-tests/draft/rollback', { path, runId });
    return data;
  });
}

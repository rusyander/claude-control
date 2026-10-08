import { useDraftMutation } from './useDraftMutation';
import { apiClient } from '@shared/api/client';
import type { ProjectTestDraftApplyResult, ProjectTestsView } from '@agentdeck/contracts';

/** Применить черновик целиком или отмеченные кейсы. */
export function useApplyTestDraft(path: string | undefined, runId: string | undefined) {
  return useDraftMutation(path, runId, async (payload: { caseIds?: string[]; auto?: boolean }) => {
    const { data } = await apiClient.post<ProjectTestDraftApplyResult & { view: ProjectTestsView }>(
      '/project-tests/draft/apply',
      { path, runId, ...payload },
    );
    return data;
  });
}

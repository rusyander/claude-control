import { useViewMutation } from './useViewMutation';
import type { ProjectTestView, ProjectTestsView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export function useSaveTestView(path: string | undefined) {
  return useViewMutation(path, async (view: ProjectTestView) => {
    const { data } = await apiClient.post<ProjectTestsView>('/project-tests/view', { path, view });
    return data;
  });
}

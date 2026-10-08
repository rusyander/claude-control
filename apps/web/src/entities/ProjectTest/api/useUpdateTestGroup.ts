import { useViewMutation } from './useViewMutation';
import { apiClient } from '@shared/api/client';
import type { ProjectTestsView } from '@agentdeck/contracts';

export function useUpdateTestGroup(path: string | undefined) {
  return useViewMutation(
    path,
    async (group: { id: string; title?: string; description?: string }) => {
      const { data } = await apiClient.post<ProjectTestsView>('/project-tests/group/update', {
        path,
        ...group,
      });
      return data;
    },
    true,
  );
}

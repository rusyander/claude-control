import { useViewMutation } from './useViewMutation';
import type { ProjectTestSchema, ProjectTestsView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export function useSaveTestSchema(path: string | undefined) {
  return useViewMutation(path, async (schema: ProjectTestSchema) => {
    const { data } = await apiClient.post<ProjectTestsView>('/project-tests/schema', {
      path,
      schema,
    });
    return data;
  });
}

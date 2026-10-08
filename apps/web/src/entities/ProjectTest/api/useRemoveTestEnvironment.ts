import { useViewMutation } from './useViewMutation';
import { apiClient } from '@shared/api/client';
import type { ProjectTestsView } from '@agentdeck/contracts';

/**
 * Убрать окружение. `force` — ответ на отказ сервера «на него ссылается план»:
 * решение «пусть план останется без окружения» принимает человек, и до его
 * нажатия удаления не происходит.
 */
export function useRemoveTestEnvironment(path: string | undefined) {
  return useViewMutation(path, async ({ id, force }: { id: string; force?: boolean }) => {
    const { data } = await apiClient.delete<ProjectTestsView>('/project-tests/environment', {
      params: { path, id, ...(force ? { force: '1' } : {}) },
    });
    return data;
  });
}

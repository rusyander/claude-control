import { useViewMutation } from './useViewMutation';
import { apiClient } from '@shared/api/client';
import type { ProjectTestsView } from '@agentdeck/contracts';

/**
 * Вписать соглашение о кейсах в `CLAUDE.md` проекта: после этого их ведёт и
 * обычный разговор, а не только прогоны из окна тестов.
 */
export function useInstallTestConvention(path: string | undefined) {
  return useViewMutation(path, async () => {
    const { data } = await apiClient.post<ProjectTestsView>('/project-tests/convention', { path });
    return data;
  });
}

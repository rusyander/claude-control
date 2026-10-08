import { useViewMutation } from './useViewMutation';
import { api } from '../../shared/api/client';
import type { ProjectTestsView } from '@agentdeck/contracts';

/**
 * Вписать соглашение о кейсах в `CLAUDE.md` проекта: после этого их ведёт и
 * обычный разговор, а не только прогоны, запущенные отсюда.
 */
export function useInstallTestConvention(projectPath: string | undefined) {
  return useViewMutation(projectPath, () =>
    api.post<ProjectTestsView>('/project-tests/convention', { path: projectPath }),
  );
}

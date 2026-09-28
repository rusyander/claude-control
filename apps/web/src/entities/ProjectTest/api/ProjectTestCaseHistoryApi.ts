import { useQuery } from '@tanstack/react-query';
import type { ProjectTestCaseHistory, ProjectTestFlakyMarks } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * История результатов кейса по прогонам и отметки «нестабилен».
 *
 * Ключи — под общим корнем тестов, так что сброс всего поддерева задевает и
 * их. Отметки ещё и привязаны к `stamp` — подписи последнего прогона агента:
 * прогон кончился, подпись сменилась, и строки библиотеки перечитывают вердикт,
 * не дожидаясь перезагрузки страницы. История кейса привязана к той же подписи:
 * без неё открытая «История» показывала прежние итоги до переоткрытия окна
 * (ревью z3 C01). Ручной проход подписи не меняет — его команды сбрасывают обе
 * ветки проекта сами (`testKeys.flaky/caseHistory`).
 */
export const caseHistoryKeys = {
  history: (path: string | undefined, groupId: string, caseId: string, stamp: string) => [
    ...testKeys.caseHistory(path),
    groupId,
    caseId,
    stamp,
  ],
  flaky: (path: string | undefined, stamp: string) => [...testKeys.flaky(path), stamp],
};

/** Запрос истории кейса; `stamp` — подпись последнего прогона агента. */
export function caseHistoryQuery(
  path: string | undefined,
  groupId: string | undefined,
  caseId: string | undefined,
  stamp = '',
) {
  return {
    queryKey: caseHistoryKeys.history(path, groupId ?? '', caseId ?? '', stamp),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestCaseHistory>('/project-tests/case-history', {
        params: { path, groupId, caseId },
      });
      return data;
    },
    enabled: Boolean(path && groupId && caseId),
  };
}

export function useTestCaseHistory(
  path: string | undefined,
  groupId: string | undefined,
  caseId: string | undefined,
  stamp = '',
) {
  return useQuery(caseHistoryQuery(path, groupId, caseId, stamp));
}

export function useTestFlakyMarks(path: string | undefined, stamp = '') {
  return useQuery({
    queryKey: caseHistoryKeys.flaky(path, stamp),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestFlakyMarks>('/project-tests/flaky', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
  });
}

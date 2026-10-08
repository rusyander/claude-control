import { caseHistoryKeys } from '../api/ProjectTestCaseHistoryApi.constants';
import { apiClient } from '@shared/api/client';
import type { ProjectTestCaseHistory } from '@agentdeck/contracts';

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

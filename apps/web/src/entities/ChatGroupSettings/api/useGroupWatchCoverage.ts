import { useQuery } from '@tanstack/react-query';
import {
  groupWatchCoverageSummaryOf,
  type GroupWatchCoverageSummary,
} from '@agentdeck/contracts/group-watch';
import { queryKeys } from '@shared/api/query-keys';
import { apiClient } from '@shared/api/client';

/** Охват меняется со стартом и концом групп, рассылки о нём нет — перечитывается сам. */
const REFRESH_MS = 60_000;

/**
 * Охват сторожа групп (`GET /api/group-watch/coverage`): строка карточки настроек.
 * Ответ разбирается на входе — сервер другой версии не роняет карточку.
 */
export function useGroupWatchCoverage() {
  return useQuery({
    queryKey: queryKeys.groupWatchCoverage,
    queryFn: async (): Promise<GroupWatchCoverageSummary> => {
      const { data } = await apiClient.get<unknown>('/group-watch/coverage');
      return groupWatchCoverageSummaryOf(data);
    },
    refetchInterval: REFRESH_MS,
  });
}

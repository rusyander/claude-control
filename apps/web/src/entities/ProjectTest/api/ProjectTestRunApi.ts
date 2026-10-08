import { useQuery } from '@tanstack/react-query';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { TESTS_POLL_MS, testKeys } from './keys';

/**
 * История прогонов, отдельная запись, отчёт и отбор по диффу — только чтение.
 *
 * Записи прогонов пишет прогон, а не панель, поэтому здесь нет ни одной
 * мутации: история — журнал, из которого ничего не правят руками. Пока прогон
 * идёт, список перечитывается — новая запись должна проступить сама.
 */

export function useTestRuns(path: string | undefined, isEnabled = true, isRunning = false) {
  return useQuery({
    queryKey: testKeys.runs(path),
    queryFn: async () => {
      const { data } = await apiClient.get<{ runs: ProjectTestRunRecord[] }>(
        '/project-tests/runs',
        { params: { path, limit: 50 } },
      );
      return data.runs;
    },
    enabled: Boolean(path) && isEnabled,
    refetchInterval: isRunning && isEnabled ? TESTS_POLL_MS : false,
  });
}

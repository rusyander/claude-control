import { useQuery } from '@tanstack/react-query';
import { testKeys } from './keys';
import { apiClient } from '@shared/api/client';
import type { ProjectTestQuarantineReport } from '@agentdeck/contracts';

/**
 * Карантин и устаревание.
 *
 * Отдельным запросом от линтера: он ходит в трекер за датами требований и потому
 * медленнее, а карточка обязана нарисоваться, не дожидаясь чужой системы.
 */
export function useTestQuarantine(path: string | undefined, isEnabled = true) {
  return useQuery({
    queryKey: testKeys.quarantine(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestQuarantineReport>(
        '/project-tests/quarantine',
        { params: { path } },
      );
      return data;
    },
    enabled: Boolean(path) && isEnabled,
  });
}

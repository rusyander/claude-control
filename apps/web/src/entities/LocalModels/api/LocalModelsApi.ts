import { useQuery } from '@tanstack/react-query';
import type { LocalModelsInfo } from '@agentdeck/contracts/local-models';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { hasRunningJob } from '../lib/hasRunningJob';

// Транспорт: чистые функции, ничего не знающие про React.

async function getLocalModels(): Promise<LocalModelsInfo> {
  const { data } = await apiClient.get<LocalModelsInfo>('/local-models');
  return data;
}

/**
 * Пока идёт загрузка, страница опрашивает раз в секунду — полоса и скорость
 * должны двигаться. Без загрузок — раз в десять секунд: загруженная в память
 * модель выгружается сама по простою, и строка «в памяти» не должна врать.
 */
const BUSY_INTERVAL_MS = 1000;
const IDLE_INTERVAL_MS = 10_000;

export function useLocalModels(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.localModels,
    queryFn: getLocalModels,
    enabled: options.enabled ?? true,
    refetchInterval: (query) =>
      hasRunningJob(query.state.data) ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS,
  });
}

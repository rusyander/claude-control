import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { ComposeInfo } from '@agentdeck/contracts';
import { queryKeys } from '@shared/api/query-keys';

/** Пока docker работает над стеком, состояние меняется каждую секунду — опрос чаще. */
const IDLE_POLL_MS = 3_000;
const JOB_POLL_MS = 1_000;

/**
 * Состав и состояние стека. Опрос идёт только при открытом окне: каждый ответ —
 * два процесса docker на сервере, держать их без зрителя незачем.
 */
export function useComposeInfo(path: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.compose(path ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<ComposeInfo>('/compose', { params: { path } });
      return data;
    },
    enabled: enabled && Boolean(path),
    refetchInterval: (query) =>
      query.state.data?.job?.status === 'running' ? JOB_POLL_MS : IDLE_POLL_MS,
  });
}

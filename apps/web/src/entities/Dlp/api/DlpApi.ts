import { useQuery } from '@tanstack/react-query';
import type { DlpInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { LIVE_INTERVAL_MS } from './DlpApi.constants';

// Транспорт: чистые функции, ничего не знающие про React.

async function getDlp(): Promise<DlpInfo> {
  const { data } = await apiClient.get<DlpInfo>('/dlp');
  return data;
}

/** Настройки, правила и состояние прокси. В сеть этот запрос не ходит. */
export function useDlp() {
  return useQuery({
    queryKey: queryKeys.dlp,
    queryFn: getDlp,
    refetchInterval: (query) => (query.state.data?.status.running ? LIVE_INTERVAL_MS : false),
  });
}

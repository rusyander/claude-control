import { useQuery } from '@tanstack/react-query';
import type { LogsSources } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/** Цели запускают и гасят из чата, сервисы — во вкладке «Сервисы»: список догоняет их опросом. */
const SOURCES_POLL_MS = 3_000;

/** Откуда можно читать логи проекта. Опрос — только при открытом окне. */
export function useLogSources(path: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.logs.sources(path ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<LogsSources>('/logs/sources', { params: { path } });
      return data;
    },
    enabled: enabled && Boolean(path),
    refetchInterval: SOURCES_POLL_MS,
  });
}

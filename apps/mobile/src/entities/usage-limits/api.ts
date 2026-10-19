import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { UsageLimits } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';
import { isConfigured } from '../../shared/api/connection';

/**
 * Лимиты подписки выбранного компьютера — те же окна, что в шапке панели.
 * Ответ идёт из кэша сервера панели (в Anthropic телефон не ходит никогда),
 * поэтому минутный опрос дешёвый; потока событий у телефона для них нет.
 */
const POLL_MS = 60_000;

export function useUsageLimits(): UseQueryResult<UsageLimits> {
  return useQuery({
    queryKey: ['usage-limits'],
    queryFn: () => api.get<UsageLimits>('/usage-limits'),
    refetchInterval: POLL_MS,
    staleTime: 30_000,
    enabled: isConfigured(),
  });
}

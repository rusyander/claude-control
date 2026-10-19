import { useQuery } from '@tanstack/react-query';
import type { UsageLimits } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Лимиты подписки. Живое обновление — событие `usage-limits` потока
 * `/api/events` (сервер спросил Anthropic и окна сдвинулись); таймер здесь —
 * запас на случай оборванного потока, а не основной путь: ответ идёт из кэша
 * сервера с ETag, и в Anthropic вкладка сама не ходит никогда.
 */
const FALLBACK_POLL_MS = 60_000;

async function getUsageLimits(): Promise<UsageLimits> {
  const { data } = await apiClient.get<UsageLimits>('/usage-limits');
  return data;
}

export function useUsageLimits() {
  return useQuery({
    queryKey: queryKeys.usageLimits,
    queryFn: getUsageLimits,
    refetchInterval: FALLBACK_POLL_MS,
  });
}

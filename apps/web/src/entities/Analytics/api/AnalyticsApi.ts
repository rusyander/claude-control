import { useQuery } from '@tanstack/react-query';
import type { Analytics, RunningAgent } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';

async function getAnalytics(days: number): Promise<Analytics> {
  const { data } = await apiClient.get<Analytics>('/analytics', { params: { days } });
  return data;
}

async function getLive(): Promise<{ runningAgents: RunningAgent[]; at: string }> {
  const { data } = await apiClient.get<{ runningAgents: RunningAgent[]; at: string }>(
    '/analytics/live',
  );
  return data;
}

export function useAnalytics(days: number) {
  return useQuery({
    queryKey: ['analytics', days],
    queryFn: () => getAnalytics(days),
    // Обход транскриптов занимает секунды, поэтому держим результат дольше
    // обычного: перещёлкивание вкладок не должно запускать пересчёт.
    staleTime: 60_000,
  });
}

/** Живой срез: запущенные процессы. Обновляется часто — он дешёвый. */
export function useLiveAgents() {
  return useQuery({
    queryKey: ['analytics', 'live'],
    queryFn: getLive,
    refetchInterval: 5_000,
    staleTime: 0,
  });
}

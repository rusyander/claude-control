import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api/client';
import type { PlatformRunPlan } from '@agentdeck/contracts';

/**
 * Чем пойдёт прогон чата: модель контура, усилие, снятые слои, отказ. Тот же
 * адрес, что спрашивает шапка чата панели; решение принимается по состоянию
 * панели, без сети дальше неё — поэтому свежесть короткая.
 */
export function usePlatformRunPlan(consumer = 'chat') {
  return useQuery({
    queryKey: ['platform-run-plan', consumer],
    queryFn: () => api.get<PlatformRunPlan>(`/platform-run-plan/${encodeURIComponent(consumer)}`),
    staleTime: 15_000,
    retry: false,
  });
}

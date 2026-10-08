import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Analytics } from '@agentdeck/contracts';
import type { AnalyticsPeriod } from './api.types';
import { analyticsQueryOptions } from './analyticsQueryOptions';

export const DEFAULT_PERIOD: AnalyticsPeriod = { kind: 'preset', preset: '7' };

export function useAnalytics(
  period: AnalyticsPeriod,
  providerId: string | undefined,
): UseQueryResult<Analytics> {
  return useQuery(analyticsQueryOptions(period, providerId));
}

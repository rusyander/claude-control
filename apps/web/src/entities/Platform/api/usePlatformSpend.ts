import type { PlatformSpendInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { path } from '../lib/path';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Расход контура по дням. Как и список карточек, наружу этот запрос НЕ ходит:
 * остаток бюджета у контура не спросить, всё считается по своему учёту.
 */
export async function getSpend(id: string): Promise<PlatformSpendInfo> {
  const { data } = await apiClient.get<PlatformSpendInfo>(path(id, '/spend'));
  return data;
}

/**
 * Расход контура по дням. Спрашивается только там, где его рисуют: в карточке
 * итог за период уже есть — он приезжает вместе со списком.
 */
export function usePlatformSpend(id: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.platformSpend(id),
    queryFn: () => getSpend(id),
    enabled: (options.enabled ?? true) && id !== '',
  });
}

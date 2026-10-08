import type { PlatformApplyPlan } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { path } from '../lib/path';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function getApplyPlan(id: string): Promise<PlatformApplyPlan> {
  const { data } = await apiClient.get<PlatformApplyPlan>(path(id, '/apply'));
  return data;
}

/**
 * Предпросмотр применения: что и куда ляжет, что уже занято, что панель уже
 * писала и что человек правил после неё. Ни одной записи здесь не происходит.
 */
export function usePlatformApplyPlan(id: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.platformApply(id),
    queryFn: () => getApplyPlan(id),
    enabled: (options.enabled ?? true) && id !== '',
  });
}

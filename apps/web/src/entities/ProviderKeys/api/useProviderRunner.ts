import type { ProviderRunnerInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function getProviderRunner(): Promise<ProviderRunnerInfo> {
  const { data } = await apiClient.get<ProviderRunnerInfo>('/provider-runner');
  return data;
}

/** Резолв раннера активного провайдера — чат по нему решает, показывать ли модалку. */
export function useProviderRunner() {
  return useQuery({ queryKey: queryKeys.providerRunner, queryFn: getProviderRunner });
}

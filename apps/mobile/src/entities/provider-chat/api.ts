import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ProvidersResponse } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';
import { isConfigured } from '../../shared/api/connection';

/** Активный CLI панели и имена всех: по ним телефон решает, чей список показывать. */
export function useProviders(): UseQueryResult<ProvidersResponse> {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<ProvidersResponse>('/providers'),
    staleTime: 30_000,
    enabled: isConfigured(),
  });
}

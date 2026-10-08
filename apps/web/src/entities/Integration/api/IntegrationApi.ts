import { useQuery } from '@tanstack/react-query';
import type { IntegrationStatus } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { integrationKeys } from './keys';

async function listIntegrations(): Promise<IntegrationStatus[]> {
  const { data } = await apiClient.get<IntegrationStatus[]>('/integrations');
  return data;
}

export function useIntegrations() {
  return useQuery({ queryKey: integrationKeys.list, queryFn: listIntegrations });
}

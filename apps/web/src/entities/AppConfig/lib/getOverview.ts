import type { Overview } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export async function getOverview(): Promise<Overview> {
  const { data } = await apiClient.get<Overview>('/overview');
  return data;
}

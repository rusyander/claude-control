import type { AnalyticsLive } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export async function getLive(): Promise<AnalyticsLive> {
  const { data } = await apiClient.get<AnalyticsLive>('/analytics/live');
  return data;
}

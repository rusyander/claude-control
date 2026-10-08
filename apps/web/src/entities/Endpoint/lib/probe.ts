import type { EndpointProbeResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export async function probe(profileId: string): Promise<EndpointProbeResult> {
  const { data } = await apiClient.post<EndpointProbeResult>(
    `/endpoints/${encodeURIComponent(profileId)}/probe`,
  );
  return data;
}

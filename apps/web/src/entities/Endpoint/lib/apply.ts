import type { EndpointApplyResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export async function apply(input: {
  profileId: string;
  provider: string;
}): Promise<EndpointApplyResult> {
  const { data } = await apiClient.post<EndpointApplyResult>(
    `/endpoints/${encodeURIComponent(input.profileId)}/apply`,
    { provider: input.provider },
  );
  return data;
}

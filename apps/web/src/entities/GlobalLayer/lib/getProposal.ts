import type { GlobalLayerProposal } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export async function getProposal(id: string): Promise<GlobalLayerProposal> {
  const { data } = await apiClient.get<GlobalLayerProposal>(`/global-layer/${id}/proposal`);
  return data;
}

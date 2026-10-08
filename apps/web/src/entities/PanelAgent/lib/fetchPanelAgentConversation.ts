import type { PanelAgentConversation } from '@agentdeck/contracts/panel-agent';
import { apiClient } from '@shared/api/client';

export async function fetchPanelAgentConversation(id: string): Promise<PanelAgentConversation> {
  const { data } = await apiClient.get<PanelAgentConversation>(
    `/agent/conversations/${encodeURIComponent(id)}`,
  );
  return data;
}

import type { PanelAgentConversation } from '@agentdeck/contracts/panel-agent';
import { api } from '../../shared/api/client';

export function fetchPanelAgentConversation(id: string): Promise<PanelAgentConversation> {
  return api.get<PanelAgentConversation>(`/agent/conversations/${encodeURIComponent(id)}`);
}

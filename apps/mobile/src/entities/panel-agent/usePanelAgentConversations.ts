import { useQuery } from '@tanstack/react-query';
import { PANEL_AGENT_KEYS } from './api.constants';
import { api } from '../../shared/api/client';
import type { PanelAgentConversationSummary } from '@agentdeck/contracts/panel-agent';
import { isConfigured } from '../../shared/api/connection';

export function usePanelAgentConversations(enabled: boolean) {
  return useQuery({
    queryKey: PANEL_AGENT_KEYS.conversations,
    queryFn: () => api.get<PanelAgentConversationSummary[]>('/agent/conversations'),
    enabled: enabled && isConfigured(),
  });
}

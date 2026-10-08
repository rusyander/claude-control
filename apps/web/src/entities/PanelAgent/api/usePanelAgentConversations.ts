import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { apiClient } from '@shared/api/client';
import type { PanelAgentConversationSummary } from '@agentdeck/contracts/panel-agent';

export function usePanelAgentConversations(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.panelAgentConversations,
    queryFn: async () =>
      (await apiClient.get<PanelAgentConversationSummary[]>('/agent/conversations')).data,
    enabled,
  });
}

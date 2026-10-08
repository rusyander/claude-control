import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { apiClient } from '@shared/api/client';
import type { PanelActionJournalEntry } from '@agentdeck/contracts/panel-agent';

export function usePanelAgentJournal(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.panelAgentJournal,
    queryFn: async () =>
      (await apiClient.get<PanelActionJournalEntry[]>('/agent/journal', { params: { limit: 100 } }))
        .data,
    enabled,
  });
}

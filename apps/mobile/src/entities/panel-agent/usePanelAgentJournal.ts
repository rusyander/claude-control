import { useQuery } from '@tanstack/react-query';
import { PANEL_AGENT_KEYS } from './api.constants';
import { api } from '../../shared/api/client';
import type { PanelActionJournalEntry } from '@agentdeck/contracts/panel-agent';
import { isConfigured } from '../../shared/api/connection';

export function usePanelAgentJournal(enabled: boolean) {
  return useQuery({
    queryKey: PANEL_AGENT_KEYS.journal,
    queryFn: () => api.get<PanelActionJournalEntry[]>('/agent/journal', { limit: 100 }),
    enabled: enabled && isConfigured(),
  });
}

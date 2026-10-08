import { useQuery } from '@tanstack/react-query';
import { fetchPanelAgentPending } from './fetchPanelAgentPending';
import { PANEL_AGENT_KEYS } from './api.constants';
import { isConfigured } from '../../shared/api/connection';

/** Опрос карточек: часто, пока экран агента открыт; редко — ради значка на вкладке. */
export const PENDING_POLL_MS = { open: 2_000, badge: 10_000 } as const;

export function usePanelAgentPending(pollMs: number) {
  return useQuery({
    queryKey: PANEL_AGENT_KEYS.pending,
    queryFn: fetchPanelAgentPending,
    refetchInterval: pollMs,
    enabled: isConfigured(),
  });
}

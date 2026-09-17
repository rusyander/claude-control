import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  PanelActionJournalEntry,
  PanelAgentConversation,
  PanelAgentConversationSummary,
  PanelPendingAction,
  PanelPendingDecision,
} from '@agentdeck/contracts/panel-agent';
import { api } from '../../shared/api/client';
import { isConfigured } from '../../shared/api/connection';

/**
 * Маршруты агента панели — те же, что зовёт окно на компьютере. Потока
 * `/api/events` у телефона нет (его рвёт фон и экономия батареи), поэтому
 * карточки опрашиваются: пропущенный кадр ничего не теряет, карточка лежит на
 * сервере до решения или таймаута.
 */

export const PANEL_AGENT_KEYS = {
  pending: ['panel-agent', 'pending'] as const,
  journal: ['panel-agent', 'journal'] as const,
  conversations: ['panel-agent', 'conversations'] as const,
};

/** Опрос карточек: часто, пока экран агента открыт; редко — ради значка на вкладке. */
export const PENDING_POLL_MS = { open: 2_000, badge: 10_000 } as const;

/** Ждущие карточки — отдельно от хука: тем же вызовом ходит живая проверка. */
export function fetchPanelAgentPending(): Promise<PanelPendingAction[]> {
  return api.get<PanelPendingAction[]>('/agent/pending');
}

export function usePanelAgentPending(pollMs: number) {
  return useQuery({
    queryKey: PANEL_AGENT_KEYS.pending,
    queryFn: fetchPanelAgentPending,
    refetchInterval: pollMs,
    enabled: isConfigured(),
  });
}

/**
 * Решение по карточке. Ответ — `{ok:true}`: итог приходит в след и в ход агента,
 * поэтому после ответа перечитываются карточки и след.
 */
export function decidePanelAction(id: string, decision: PanelPendingDecision['decision']) {
  return api.post<{ ok: true }>(`/agent/pending/${encodeURIComponent(id)}`, { decision });
}

export function useDecidePanelAction() {
  return useMutation({
    mutationFn: ({ id, decision }: { id: string } & PanelPendingDecision) =>
      decidePanelAction(id, decision),
  });
}

export function usePanelAgentJournal(enabled: boolean) {
  return useQuery({
    queryKey: PANEL_AGENT_KEYS.journal,
    queryFn: () => api.get<PanelActionJournalEntry[]>('/agent/journal', { limit: 100 }),
    enabled: enabled && isConfigured(),
  });
}

export function usePanelAgentConversations(enabled: boolean) {
  return useQuery({
    queryKey: PANEL_AGENT_KEYS.conversations,
    queryFn: () => api.get<PanelAgentConversationSummary[]>('/agent/conversations'),
    enabled: enabled && isConfigured(),
  });
}

export function fetchPanelAgentConversation(id: string): Promise<PanelAgentConversation> {
  return api.get<PanelAgentConversation>(`/agent/conversations/${encodeURIComponent(id)}`);
}

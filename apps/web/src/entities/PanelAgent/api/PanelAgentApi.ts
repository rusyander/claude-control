import { useMutation, useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import type {
  PanelActionJournalEntry,
  PanelAgentConversation,
  PanelAgentConversationSummary,
  PanelPendingAction,
  PanelPendingDecision,
} from '@agentdeck/contracts/panel-agent';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Ждущие карточки. Читаются при открытии окна и после переподключения потока:
 * кадр `agent-pending`, пришедший, пока окна не было, иначе потерялся бы, а
 * агент ждал бы клика, которого человеку не показали.
 */
export function usePanelAgentPending() {
  return useQuery({
    queryKey: queryKeys.panelAgentPending,
    queryFn: async () => (await apiClient.get<PanelPendingAction[]>('/agent/pending')).data,
  });
}

/**
 * Решение по карточке. Ответ — только `{ok:true}`: итог (выполнено, ошибка
 * маршрута) приходит кадром `agent-decided`, поэтому карточку снимает кадр, а
 * не этот ответ.
 */
export function useDecidePanelAction() {
  return useMutation({
    // Причину отказа карточка показывает сама, под кнопками: тост с сырым
    // текстом сервера рядом повторял бы её (и по-английски, у 409).
    meta: { silentError: true },
    mutationFn: async ({ id, decision }: { id: string } & PanelPendingDecision) => {
      const body: PanelPendingDecision = { decision };
      await apiClient.post(`/agent/pending/${encodeURIComponent(id)}`, body);
    },
  });
}

/**
 * Сервер не принял одобрение: предпросмотр карточки неполный (409
 * `preview_truncated`). Карточка об этом могла не знать — окно гасит «Выполнить»
 * и оставляет её ждать отклонения, а не показывает общий «не принято».
 */
export function isPreviewTruncatedRefusal(error: unknown): boolean {
  if (!isAxiosError(error) || error.response?.status !== 409) return false;
  const data = error.response.data as { error?: unknown } | undefined;
  return data?.error === 'preview_truncated';
}

export function usePanelAgentJournal(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.panelAgentJournal,
    queryFn: async () =>
      (await apiClient.get<PanelActionJournalEntry[]>('/agent/journal', { params: { limit: 100 } }))
        .data,
    enabled,
  });
}

export function usePanelAgentConversations(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.panelAgentConversations,
    queryFn: async () =>
      (await apiClient.get<PanelAgentConversationSummary[]>('/agent/conversations')).data,
    enabled,
  });
}

export async function fetchPanelAgentConversation(id: string): Promise<PanelAgentConversation> {
  const { data } = await apiClient.get<PanelAgentConversation>(
    `/agent/conversations/${encodeURIComponent(id)}`,
  );
  return data;
}

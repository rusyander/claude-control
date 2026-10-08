import { useQuery } from '@tanstack/react-query';
import type { PanelPendingAction } from '@agentdeck/contracts/panel-agent';
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

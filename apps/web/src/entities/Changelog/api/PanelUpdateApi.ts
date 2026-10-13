import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import type { PanelUpdateResult, PanelUpdateStatus } from '@agentdeck/contracts/changelog';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Обновление самой панели. Сервер сам делает `git fetch` не чаще раза в 10
 * минут, поэтому опрос раз в 5 минут дёшев: он читает уже полученный снимок.
 * «Проверить сейчас» просит fetch немедленно.
 */
const POLL_MS = 5 * 60_000;

async function fetchPanelUpdate(refresh = false): Promise<PanelUpdateStatus> {
  const { data } = await apiClient.get<PanelUpdateStatus>('/panel-update', {
    params: refresh ? { refresh: '1' } : undefined,
  });
  return data;
}

export function usePanelUpdate() {
  return useQuery({
    queryKey: queryKeys.panelUpdate,
    queryFn: () => fetchPanelUpdate(),
    refetchInterval: POLL_MS,
  });
}

export function useCheckPanelUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => fetchPanelUpdate(true),
    onSuccess: (status) => queryClient.setQueryData(queryKeys.panelUpdate, status),
  });
}

export function useApplyPanelUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<PanelUpdateResult>('/panel-update');
      return data;
    },
    // Итог и отказ называет сама карточка — общий тост дал бы второй.
    meta: { silentError: true },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.panelUpdate, result.status);
      if (result.ok) void queryClient.invalidateQueries({ queryKey: queryKeys.changelog });
    },
  });
}

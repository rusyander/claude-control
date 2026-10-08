import { useMutation } from '@tanstack/react-query';
import type { GlobalLayerTransferRequest, GlobalLayerTransferResponse } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

/** Задание переноса; состояние пары оно не меняет — перечитывать нечего. */
export function useGlobalTransfer() {
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: GlobalLayerTransferRequest }) => {
      const { data } = await apiClient.post<GlobalLayerTransferResponse>(
        `/global-layer/${id}/transfer`,
        body,
      );
      return data;
    },
    meta: { silentError: true },
  });
}

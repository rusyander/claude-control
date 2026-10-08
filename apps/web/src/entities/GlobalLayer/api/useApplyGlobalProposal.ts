import { useLayerAction } from './useLayerAction';
import type { GlobalLayerApplyRequest, GlobalLayerApplyResponse } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export const useApplyGlobalProposal = () =>
  useLayerAction<{ id: string; body: GlobalLayerApplyRequest }, GlobalLayerApplyResponse>(
    async ({ id, body }) => {
      const { data } = await apiClient.post<GlobalLayerApplyResponse>(
        `/global-layer/${id}/apply`,
        body,
      );
      return data;
    },
  );

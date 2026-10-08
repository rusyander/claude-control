import { useLayerAction } from './useLayerAction';
import type { GlobalLayerPairView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export const useCompareGlobalLayer = () =>
  useLayerAction<string, GlobalLayerPairView>(async (id) => {
    const { data } = await apiClient.post<GlobalLayerPairView>(`/global-layer/${id}/compare`, {});
    return data;
  });

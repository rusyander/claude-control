import { useKitMutation } from './useKitMutation';
import { apiClient } from '@shared/api/client';
import type { KitResponse } from '@agentdeck/contracts/kit';

export const useResetKitItem = () =>
  useKitMutation<string>(async (id) => {
    const { data } = await apiClient.delete<KitResponse>('/kit/item', { params: { id } });
    return data;
  });

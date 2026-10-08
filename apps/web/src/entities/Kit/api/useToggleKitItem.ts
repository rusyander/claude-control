import { useKitMutation } from './useKitMutation';
import { apiClient } from '@shared/api/client';
import type { KitResponse } from '@agentdeck/contracts/kit';

export const useToggleKitItem = () =>
  useKitMutation<{ id: string; enabled: boolean }>(async (body) => {
    const { data } = await apiClient.put<KitResponse>('/kit/item/enabled', body);
    return data;
  });

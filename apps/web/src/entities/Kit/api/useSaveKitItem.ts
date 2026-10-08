import { useKitMutation } from './useKitMutation';
import { apiClient } from '@shared/api/client';
import type { KitResponse } from '@agentdeck/contracts/kit';

export const useSaveKitItem = () =>
  useKitMutation<{ id: string; content: string }>(async (body) => {
    const { data } = await apiClient.put<KitResponse>('/kit/item', body);
    return data;
  });

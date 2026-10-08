import { useKitMutation } from './useKitMutation';
import { apiClient } from '@shared/api/client';
import type { KitResponse } from '@agentdeck/contracts/kit';

export const useKitConflictWinner = () =>
  useKitMutation<{ id: string; winner: 'user' | 'kit' }>(async (body) => {
    const { data } = await apiClient.put<KitResponse>('/kit/conflict', body);
    return data;
  });

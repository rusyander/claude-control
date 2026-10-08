import { useKitMutation } from './useKitMutation';
import type { KitMode } from '@agentdeck/contracts/local-models';
import { apiClient } from '@shared/api/client';
import type { KitResponse } from '@agentdeck/contracts/kit';

export const useSetKitProviderMode = () =>
  useKitMutation<{ provider: string; mode: KitMode }>(async (body) => {
    const { data } = await apiClient.put<KitResponse>('/kit/mode', body);
    return data;
  });

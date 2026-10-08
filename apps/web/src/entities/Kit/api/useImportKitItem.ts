import { useKitMutation } from './useKitMutation';
import type { KitTwinKind, KitResponse } from '@agentdeck/contracts/kit';
import { apiClient } from '@shared/api/client';

export const useImportKitItem = () =>
  useKitMutation<{ kind: KitTwinKind; name: string }>(async (body) => {
    const { data } = await apiClient.post<KitResponse>('/kit/global/import', body);
    return data;
  });

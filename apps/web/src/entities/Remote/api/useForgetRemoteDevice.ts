import { useRemoteMutation } from './useRemoteMutation';
import { apiClient } from '@shared/api/client';
import type { RemoteAccessStatus } from '@agentdeck/contracts';

export function useForgetRemoteDevice() {
  return useRemoteMutation(async (token: string) => {
    const { data } = await apiClient.delete<RemoteAccessStatus>('/remote/devices', {
      data: { token },
    });
    return data;
  });
}

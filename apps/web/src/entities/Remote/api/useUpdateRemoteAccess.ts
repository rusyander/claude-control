import { useRemoteMutation } from './useRemoteMutation';
import type { RemoteAccessSettings, RemoteAccessStatus } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export function useUpdateRemoteAccess() {
  return useRemoteMutation(async (input: Partial<RemoteAccessSettings>) => {
    const { data } = await apiClient.patch<RemoteAccessStatus>('/remote', input);
    return data;
  });
}

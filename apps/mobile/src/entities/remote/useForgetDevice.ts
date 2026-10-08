import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RemoteAccessStatus } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';

export function useForgetDevice(): ReturnType<
  typeof useMutation<RemoteAccessStatus, Error, string>
> {
  const queryClient = useQueryClient();
  return useMutation<RemoteAccessStatus, Error, string>({
    mutationFn: (token) => api.delete<RemoteAccessStatus>('/remote/devices', { token }),
    onSuccess: (status) => queryClient.setQueryData(['remote'], status),
  });
}

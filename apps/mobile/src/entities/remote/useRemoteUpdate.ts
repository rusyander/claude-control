import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RemoteAccessStatus } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';

export function useRemoteUpdate(): ReturnType<
  typeof useMutation<RemoteAccessStatus, Error, { notify?: boolean; publicUrl?: string }>
> {
  const queryClient = useQueryClient();
  return useMutation<RemoteAccessStatus, Error, { notify?: boolean; publicUrl?: string }>({
    mutationFn: (body) => api.patch<RemoteAccessStatus>('/remote', body),
    onSuccess: (status) => queryClient.setQueryData(['remote'], status),
  });
}

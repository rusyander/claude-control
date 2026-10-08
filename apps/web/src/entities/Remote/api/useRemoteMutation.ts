import type { RemoteAccessStatus } from '@agentdeck/contracts';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

/** Обвязка записи: ответ кладём в кэш как новое состояние. */
export function useRemoteMutation<TInput>(request: (input: TInput) => Promise<RemoteAccessStatus>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (status) => queryClient.setQueryData(queryKeys.remote, status),
  });
}

import { useQueryClient, useMutation } from '@tanstack/react-query';
import { clearToken } from '../lib/clearToken';

/** Забыть токен профиля. */
export function useClearEndpointToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: clearToken,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['endpoints'] }),
  });
}

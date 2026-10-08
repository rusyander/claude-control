import { useQueryClient, useMutation } from '@tanstack/react-query';
import { CREDENTIALS_KEY } from './CredentialsApi.constants';
import { clearCredentials } from '../lib/clearCredentials';

export function useClearCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: clearCredentials,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY }),
  });
}

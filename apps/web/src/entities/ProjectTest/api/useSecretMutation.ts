import type { SecretsResponse } from './ProjectTestSecretApi.types';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { testKeys } from './keys';

export function useSecretMutation<TVariables>(
  path: string | undefined,
  send: (variables: TVariables) => Promise<SecretsResponse>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (data) => {
      client.setQueryData(testKeys.secrets(path, data.environmentId), {
        environmentId: data.environmentId,
        secrets: data.secrets,
      });
      client.setQueryData(testKeys.view(path), data.view);
    },
  });
}

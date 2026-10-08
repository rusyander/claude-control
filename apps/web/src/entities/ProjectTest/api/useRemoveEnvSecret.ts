import { useSecretMutation } from './useSecretMutation';
import { apiClient } from '@shared/api/client';
import type { SecretsResponse } from './ProjectTestSecretApi.types';

export function useRemoveEnvSecret(path: string | undefined) {
  return useSecretMutation(path, async (payload: { environmentId: string; name: string }) => {
    const { data } = await apiClient.delete<SecretsResponse>('/project-tests/env-secret', {
      params: { path, ...payload },
    });
    return data;
  });
}

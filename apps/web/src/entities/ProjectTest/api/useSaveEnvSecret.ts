import { useSecretMutation } from './useSecretMutation';
import { apiClient } from '@shared/api/client';
import type { SecretsResponse } from './ProjectTestSecretApi.types';

export interface SaveEnvSecretPayload {
  environmentId: string;
  name: string;
  title?: string;
  /** Не передано — меняется только подпись; пустая строка стирает значение. */
  value?: string;
}

export function useSaveEnvSecret(path: string | undefined) {
  return useSecretMutation(path, async (payload: SaveEnvSecretPayload) => {
    const { data } = await apiClient.post<SecretsResponse>('/project-tests/env-secret', {
      path,
      ...payload,
    });
    return data;
  });
}

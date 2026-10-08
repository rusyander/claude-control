import type { ProviderMigrateRequest, ProviderMigrateResponse } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { useMutation } from '@tanstack/react-query';

export async function postMigrate(
  request: ProviderMigrateRequest,
): Promise<ProviderMigrateResponse> {
  const { data } = await apiClient.post<ProviderMigrateResponse>('/provider-migrate', request);
  return data;
}

/**
 * Перенос записей. Одна и та же мутация служит и предпросмотру, и записи —
 * разница только в `mode`, и это сознательно: разойтись они не смогут.
 */
export function useMigrateProvider() {
  return useMutation({ mutationFn: postMigrate });
}

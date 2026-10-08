import { useIntegrationMutation } from './useIntegrationMutation';
import type { IntegrationId, IntegrationStatus } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export function useForgetIntegration() {
  return useIntegrationMutation(async (id: IntegrationId) => {
    const { data } = await apiClient.delete<IntegrationStatus>(
      `/integrations/${encodeURIComponent(id)}`,
    );
    return data;
  }, 'toasts.deleted');
}

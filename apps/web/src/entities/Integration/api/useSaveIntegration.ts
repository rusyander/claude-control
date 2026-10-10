import type { IntegrationId, IntegrationStatus } from '@agentdeck/contracts';
import { useIntegrationMutation } from './useIntegrationMutation';
import { apiClient } from '@shared/api/client';

export interface SaveIntegrationPayload {
  id: IntegrationId;
  /** Несекретная часть: адрес, почта, репозиторий, ключ проекта. */
  settings: Record<string, unknown>;
  /** Не задан — прежний токен остаётся; пустая строка — забыть его. */
  token?: string;
}

export function useSaveIntegration() {
  return useIntegrationMutation(async ({ id, settings, token }: SaveIntegrationPayload) => {
    const { data } = await apiClient.put<IntegrationStatus>(
      `/integrations/${encodeURIComponent(id)}`,
      {
        settings,
        ...(token === undefined ? {} : { token }),
      },
    );
    return data;
  }, 'toasts.saved');
}

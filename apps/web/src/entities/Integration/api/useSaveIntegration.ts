import type { IntegrationId, IntegrationStatus } from '@agentdeck/contracts';
import { useIntegrationMutation } from './useIntegrationMutation';
import { apiClient } from '@shared/api/client';

export interface SaveIntegrationPayload {
  id: IntegrationId;
  /** Несекретная часть: адрес, почта, репозиторий, ключ проекта. */
  settings: Record<string, unknown>;
  /** Не задан — прежний токен остаётся; пустая строка — забыть его. */
  token?: string;
  /**
   * Второй ключ Atlassian — личный токен Confluence. То же правило: не задан —
   * прежний остаётся. У остальных коннекторов поля нет, и сервер его не читает.
   */
  confluenceToken?: string;
}

export function useSaveIntegration() {
  return useIntegrationMutation(
    async ({ id, settings, token, confluenceToken }: SaveIntegrationPayload) => {
      const { data } = await apiClient.put<IntegrationStatus>(
        `/integrations/${encodeURIComponent(id)}`,
        {
          settings,
          ...(token === undefined ? {} : { token }),
          ...(confluenceToken === undefined ? {} : { confluenceToken }),
        },
      );
      return data;
    },
    'toasts.saved',
  );
}

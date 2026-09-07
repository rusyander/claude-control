import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IntegrationId, IntegrationStatus } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { integrationKeys } from './keys';

/**
 * Пять внешних коннекторов панели: Atlassian, фордж по токену, Telegram,
 * тест-менеджмент и CI.
 *
 * Секрет сюда не приходит и отсюда не уходит обратно: при сохранении токен
 * передаётся один раз, а в ответе живёт только маска. Пустая строка в поле
 * токена — это «забыть», а отсутствующее поле — «оставить как есть»: без такого
 * различия любое изменение адреса стирало бы сохранённый ключ.
 *
 * Настройки коннекторов лежат в общих настройках панели, поэтому каждая запись
 * сбрасывает и их кэш — иначе поля на экране остались бы прежними.
 */

/** Сколько ждать живую проверку: она ходит в чужой сервис, 15 c плюс ретрай. */
const CHECK_TIMEOUT_MS = 45_000;

async function listIntegrations(): Promise<IntegrationStatus[]> {
  const { data } = await apiClient.get<IntegrationStatus[]>('/integrations');
  return data;
}

export function useIntegrations() {
  return useQuery({ queryKey: integrationKeys.list, queryFn: listIntegrations });
}

/** Общая часть команд: ответ — статус коннектора, и он же обновляет настройки. */
function useIntegrationMutation<TVariables>(
  send: (variables: TVariables) => Promise<IntegrationStatus>,
  successMessage?: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: integrationKeys.root });
      void client.invalidateQueries({ queryKey: queryKeys.settings });
    },
    meta: successMessage ? { successMessage } : undefined,
  });
}

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
      token === undefined ? { settings } : { settings, token },
    );
    return data;
  }, 'toasts.saved');
}

/** Живая проверка связи. Тоста об успехе нет: результат виден в самой карточке. */
export function useCheckIntegration() {
  return useIntegrationMutation(async (id: IntegrationId) => {
    const { data } = await apiClient.post<IntegrationStatus>(
      `/integrations/${encodeURIComponent(id)}/check`,
      {},
      { timeout: CHECK_TIMEOUT_MS },
    );
    return data;
  });
}

export function useForgetIntegration() {
  return useIntegrationMutation(async (id: IntegrationId) => {
    const { data } = await apiClient.delete<IntegrationStatus>(
      `/integrations/${encodeURIComponent(id)}`,
    );
    return data;
  }, 'toasts.deleted');
}

/**
 * Проверка Telegram отдельным маршрутом: она не «дозвонилась ли панель до
 * Bot API», а «пришло ли сообщение в тот чат» — а это видно только в чате.
 */
export function useTestTelegram() {
  return useMutation({
    mutationFn: async (): Promise<{ ok: boolean }> => {
      const { data } = await apiClient.post<{ ok: boolean }>('/integrations/telegram/test', {});
      return data;
    },
    meta: { successMessage: 'integrations.telegram.sent' },
  });
}

/**
 * Проверка вебхука — настоящий POST на указанный адрес: «панель настроена»
 * и «приёмник принял» — разные утверждения, и человеку нужно второе.
 */
export function useTestWebhook() {
  return useMutation({
    mutationFn: async (): Promise<{ ok: boolean }> => {
      const { data } = await apiClient.post<{ ok: boolean }>('/integrations/webhook/test', {});
      return data;
    },
    meta: { successMessage: 'integrations.webhook.sent' },
  });
}

/**
 * Собственный MCP-сервер панели над Atlassian: регистрация — действие ЧЕЛОВЕКА.
 * Автоматически панель чужой CLI не переписывает, поэтому это кнопка, а не
 * следствие включённого коннектора.
 */
export function useConnectAtlassianMcp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (isConnected: boolean): Promise<void> => {
      if (isConnected) await apiClient.delete('/integrations/mcp/connect');
      else await apiClient.post('/integrations/mcp/connect', {});
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: integrationKeys.root });
      void client.invalidateQueries({ queryKey: queryKeys.mcp });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}

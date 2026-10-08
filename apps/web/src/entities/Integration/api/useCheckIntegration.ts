import { useIntegrationMutation } from './useIntegrationMutation';
import type { IntegrationId, IntegrationStatus } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

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
export const CHECK_TIMEOUT_MS = 45_000;

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

import { useQuery } from '@tanstack/react-query';
import type { ProviderEnvInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Универсальные переменные окружения активного провайдера (Codex). Отдельный от
 * Claude набор запросов: Claude env живёт на богатых роутах `/api/env` со своей
 * страницей (источники, маски, перенос) — клиент выбирает набор по активному
 * провайдеру. GET возвращает не просто список, а `ProviderEnvInfo` (переменные +
 * метаданные: формат, путь, найден ли CLI, флаг readOnly). Запись — bulk: PUT
 * сохраняет полный желаемый набор пар (add/edit/delete на клиенте сводятся к нему).
 */

async function getProviderEnv(): Promise<ProviderEnvInfo> {
  const { data } = await apiClient.get<ProviderEnvInfo>('/provider-env');
  return data;
}

export function useProviderEnv() {
  return useQuery({ queryKey: queryKeys.providerEnv, queryFn: getProviderEnv });
}

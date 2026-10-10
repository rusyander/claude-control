import { useQuery } from '@tanstack/react-query';
import type { IntegrationDiscovery } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { integrationKeys } from './keys';

async function discover(): Promise<IntegrationDiscovery> {
  const { data } = await apiClient.get<IntegrationDiscovery>('/integrations/discover');
  return data;
}

/**
 * «Найти уже подключённые»: интеграции среди MCP-серверов человека.
 *
 * Поиск — действие, а не фон: он читает чужие конфигурации и файл секретов,
 * поэтому идёт только пока открыта панель находок. Кэш не держится: правка
 * `~/.claude.json` между двумя открытиями должна быть видна сразу.
 */
export function useIntegrationDiscovery(isEnabled: boolean) {
  return useQuery({
    queryKey: integrationKeys.discover,
    queryFn: discover,
    enabled: isEnabled,
    staleTime: 0,
    gcTime: 0,
  });
}

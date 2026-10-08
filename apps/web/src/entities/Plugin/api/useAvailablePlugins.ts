import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { Plugin } from '@agentdeck/contracts';

/**
 * Каталог маркетплейсов. Запрос идёт в сеть и обновляет репозитории — это
 * десятки секунд, поэтому он не выполняется сам: страница запрашивает каталог
 * только когда пользователь его открыл, и потом держит в кеше.
 */
export function useAvailablePlugins(isEnabled: boolean) {
  return useQuery({
    queryKey: ['plugins', 'available'],
    queryFn: async () => {
      const { data } = await apiClient.get<Plugin[]>('/plugins/available', { timeout: 300_000 });
      return data;
    },
    enabled: isEnabled,
    staleTime: 30 * 60 * 1000,
  });
}

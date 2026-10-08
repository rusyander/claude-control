import { useQuery } from '@tanstack/react-query';
import type { IntegrationLinks } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { integrationKeys } from './keys';

/**
 * Привязки проекта к внешнему миру: куда заводить дефекты, где лежат требования,
 * куда публиковать отчёт.
 *
 * Это единственное, чего агент знать не может сам, — и именно это уходит ему
 * строкой в задании. Хранится по абсолютному пути проекта, а не по его id в
 * реестре: проект в реестре может отсутствовать, а тесты у него всё равно есть.
 *
 * У группы тестов своя привязка поверх проектной: набор «Оплата» ведут в одном
 * эпике, «Профиль» — в другом, а требования лежат на разных страницах.
 */

export function useIntegrationLinks(path: string | undefined, isEnabled = true) {
  return useQuery({
    queryKey: integrationKeys.links(path),
    queryFn: async (): Promise<IntegrationLinks> => {
      const { data } = await apiClient.get<IntegrationLinks>('/integrations/links', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path) && isEnabled,
  });
}

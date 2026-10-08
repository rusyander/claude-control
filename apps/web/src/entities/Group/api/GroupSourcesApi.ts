import { useQuery } from '@tanstack/react-query';
import type { DiscoveryView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Откуда берутся группы: обнаружение по проектам и общим каталогам, импорт
// находки, копия проектной группы в общие, выбор стороны пары в проекте и файл
// переопределения. Всё вложено в ключ `groups`, поэтому любая правка группы
// освежает и находки, и выбор — отдельной инвалидации тут не нужно.

/** Пока обнаружение идёт, строка прогресса по источникам опрашивается вот так часто. */
const DISCOVERY_POLL_MS = 1_500;

async function getDiscovery(): Promise<DiscoveryView> {
  const { data } = await apiClient.get<DiscoveryView>('/groups/discovery');
  return data;
}

/**
 * Находки обнаружения. Прогресс приходит опросом: сервер отвечает на запуск
 * сразу (202), а по источникам отчитывается в том же GET — пока `running`,
 * страница переспрашивает, потом замолкает.
 */
export function useGroupDiscovery() {
  return useQuery({
    queryKey: queryKeys.groupDiscovery,
    queryFn: getDiscovery,
    refetchInterval: (query) => (query.state.data?.running ? DISCOVERY_POLL_MS : false),
  });
}

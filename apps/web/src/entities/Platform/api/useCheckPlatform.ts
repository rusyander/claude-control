import type {
  PlatformHealthRecord,
  PlatformProbeResult,
  PlatformsInfo,
} from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { path } from '../lib/path';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Дата последнего успеха живёт по тому же правилу, что и на сервере: неудачная
 * проба её не стирает. Иначе карточка теряла бы «а три часа назад отвечал» до
 * перезагрузки списка.
 */
export function lastOkPatch(
  fresh: PlatformHealthRecord,
  previous: PlatformHealthRecord | undefined,
): { lastOkAt?: string } {
  if (fresh.outcome === 'ok') return { lastOkAt: fresh.checkedAt };
  if (previous?.lastOkAt) return { lastOkAt: previous.lastOkAt };
  return {};
}

export async function checkPlatform(id: string): Promise<PlatformProbeResult> {
  const { data } = await apiClient.post<PlatformProbeResult>(path(id, '/check'));
  return data;
}

/**
 * Живая проба. Ответ никогда не отказ: недоступный контур — это результат с
 * причиной. Итог кладём в кеш списка сами — он переживает F5 на сервере, но
 * перезапрашивать весь список ради одной карточки незачем.
 */
export function useCheckPlatform() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: checkPlatform,
    onSuccess: (health, id) => {
      queryClient.setQueryData<PlatformsInfo>(queryKeys.platforms, (info) =>
        info
          ? {
              ...info,
              platforms: info.platforms.map((item) =>
                item.platform.id === id
                  ? {
                      ...item,
                      // Дата последнего успеха живёт по тому же правилу, что и
                      // на сервере: неудачная проба её не стирает. Иначе
                      // карточка теряла бы «а три часа назад отвечал» до
                      // перезагрузки списка.
                      health: { ...health, ...lastOkPatch(health, item.health) },
                    }
                  : item,
              ),
            }
          : info,
      );
      // Проба уточняет возможности контура — значит и то, что панель считает
      // применимым.
      void queryClient.invalidateQueries({ queryKey: queryKeys.platformApply(id) });
    },
  });
}

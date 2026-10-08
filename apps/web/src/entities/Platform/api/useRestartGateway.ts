import type { PlatformGatewayInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function restartGateway(): Promise<PlatformGatewayInfo> {
  const { data } = await apiClient.post<PlatformGatewayInfo>('/platforms/gateway/restart');
  return data;
}

/**
 * Поднять или погасить слушатель ПО СОХРАНЁННОЙ НАСТРОЙКЕ. Своих параметров у
 * маршрута нет: настройка правится общим PATCH, здесь применяется уже
 * сохранённое.
 */
export function useRestartGateway() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: restartGateway,
    onSuccess: (info) => {
      queryClient.setQueryData(queryKeys.platformGateway, info);
      // Поднявшийся шлюз меняет `ready` в плане применения каждого контура:
      // без сброса кнопка «Применить» осталась бы заблокированной у живого шлюза.
      void queryClient.invalidateQueries({ queryKey: queryKeys.platforms });
    },
  });
}

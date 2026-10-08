import type { PlatformGatewayInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function startGateway(): Promise<PlatformGatewayInfo> {
  const { data } = await apiClient.post<PlatformGatewayInfo>('/platforms/gateway/start');
  return data;
}

/**
 * «Поднять шлюз» с карточки: сервер сам включает настройку и поднимает
 * слушатель, живой не трогает. Сброс списка контуров снимает и отказ в шапке
 * чата — план прогона лежит под тем же ключом.
 */
export function useStartGateway() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: startGateway,
    onSuccess: (info) => {
      queryClient.setQueryData(queryKeys.platformGateway, info);
      void queryClient.invalidateQueries({ queryKey: queryKeys.platforms });
    },
  });
}

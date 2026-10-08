import { useQuery } from '@tanstack/react-query';
import { portKey } from '../lib/portKey';
import { apiClient } from '@shared/api/client';
import type { PortHoldersInfo } from '@agentdeck/contracts';

/**
 * Кто занимает порт. Спрашиваем только когда сервер уже пожаловался на
 * занятость: пользователь должен видеть, кого ему предлагают погасить.
 */
export function usePortHolders(port: number | undefined) {
  return useQuery({
    queryKey: portKey(port ?? 0),
    queryFn: async () => {
      const { data } = await apiClient.get<PortHoldersInfo>('/project-runner/port', {
        params: { port },
      });
      return data;
    },
    enabled: Boolean(port),
    staleTime: 5_000,
  });
}

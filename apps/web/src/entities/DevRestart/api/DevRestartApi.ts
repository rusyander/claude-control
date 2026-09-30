import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DevRestartStatus } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Отложенный перезапуск dev-сервера (решение 30.09): правки кода сервера ждут
 * конца живых ходов без предела, и панель обязана это показать — иначе человек
 * правит сервер и не понимает, почему правка «не работает».
 *
 * Опрос редкий: ждать правкам обычно минуты, а после перезапуска сервер
 * отвечает уже «не ждут», и плашка уходит сама.
 */
const POLL_MS = 10_000;

async function getDevRestart(): Promise<DevRestartStatus> {
  const { data } = await apiClient.get<DevRestartStatus>('/dev-restart');
  return data;
}

export function useDevRestart() {
  return useQuery({
    queryKey: queryKeys.devRestart,
    queryFn: getDevRestart,
    refetchInterval: POLL_MS,
    // Старый сервер без маршрута или сервер в перезапуске — плашки просто нет.
    retry: false,
  });
}

export function useRequestDevRestart() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<DevRestartStatus>('/dev-restart');
      return data;
    },
    onSuccess: (status) => queryClient.setQueryData(queryKeys.devRestart, status),
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RemoteAccessSettings, RemoteAccessStatus } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Удалённый доступ: включён ли он, каким токеном открывается и какие телефоны
 * получают уведомления.
 *
 * Каждая операция возвращает уже НОВОЕ состояние, поэтому кэш обновляется
 * ответом, без запроса следом: смена токена и отвязка устройства меняют один и
 * тот же объект, и второй запрос показал бы промежуточную картину.
 */

async function getRemote(): Promise<RemoteAccessStatus> {
  const { data } = await apiClient.get<RemoteAccessStatus>('/remote');
  return data;
}

export function useRemoteAccess() {
  return useQuery({ queryKey: queryKeys.remote, queryFn: getRemote });
}

/** Обвязка записи: ответ кладём в кэш как новое состояние. */
function useRemoteMutation<TInput>(request: (input: TInput) => Promise<RemoteAccessStatus>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (status) => queryClient.setQueryData(queryKeys.remote, status),
  });
}

export function useUpdateRemoteAccess() {
  return useRemoteMutation(async (input: Partial<RemoteAccessSettings>) => {
    const { data } = await apiClient.patch<RemoteAccessStatus>('/remote', input);
    return data;
  });
}

/**
 * Новый токен. Спаренные телефоны после этого перестают ходить — это и есть
 * кнопка «я потерял телефон», а не косметическая ротация.
 */
export function useRotateRemoteToken() {
  return useRemoteMutation(async () => {
    const { data } = await apiClient.post<RemoteAccessStatus>('/remote/token');
    return data;
  });
}

export function useForgetRemoteDevice() {
  return useRemoteMutation(async (token: string) => {
    const { data } = await apiClient.delete<RemoteAccessStatus>('/remote/devices', {
      data: { token },
    });
    return data;
  });
}

/** Проверочное уведомление на все привязанные телефоны. */
export function useTestRemoteNotification() {
  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<{ ok: boolean; devices: number }>('/remote/test');
      return data;
    },
  });
}

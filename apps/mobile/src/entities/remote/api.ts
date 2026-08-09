import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { RemoteAccessStatus } from '@claude-control/contracts';
import { api } from '../../shared/api/client';

/**
 * Удалённый доступ глазами телефона: включён ли он, каким адресом панель себя
 * считает и какие устройства к ней привязаны.
 *
 * Токен в ответе есть, но приложению он не нужен — свой оно уже сохранило при
 * спаривании. Показывать его на телефоне незачем: перенести его отсюда некуда.
 */

export function useRemote(): UseQueryResult<RemoteAccessStatus> {
  return useQuery({
    queryKey: ['remote'],
    queryFn: () => api.get<RemoteAccessStatus>('/remote'),
    staleTime: 30_000,
  });
}

export function useRemoteUpdate(): ReturnType<
  typeof useMutation<RemoteAccessStatus, Error, { notify?: boolean; publicUrl?: string }>
> {
  const queryClient = useQueryClient();
  return useMutation<RemoteAccessStatus, Error, { notify?: boolean; publicUrl?: string }>({
    mutationFn: (body) => api.patch<RemoteAccessStatus>('/remote', body),
    onSuccess: (status) => queryClient.setQueryData(['remote'], status),
  });
}

export function useForgetDevice(): ReturnType<
  typeof useMutation<RemoteAccessStatus, Error, string>
> {
  const queryClient = useQueryClient();
  return useMutation<RemoteAccessStatus, Error, string>({
    mutationFn: (token) => api.delete<RemoteAccessStatus>('/remote/devices', { token }),
    onSuccess: (status) => queryClient.setQueryData(['remote'], status),
  });
}

/** Проверочное уведомление: путь до телефона длинный, и «не пришло» надо ловить сразу. */
export function useTestNotification(): ReturnType<
  typeof useMutation<{ ok: boolean; devices: number }, Error, void>
> {
  return useMutation<{ ok: boolean; devices: number }, Error, void>({
    mutationFn: () => api.post<{ ok: boolean; devices: number }>('/remote/test'),
  });
}

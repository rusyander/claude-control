import { useMutation } from '@tanstack/react-query';
import { api } from '../../shared/api/client';

/** Проверочное уведомление: путь до телефона длинный, и «не пришло» надо ловить сразу. */
export function useTestNotification(): ReturnType<
  typeof useMutation<{ ok: boolean; devices: number }, Error, void>
> {
  return useMutation<{ ok: boolean; devices: number }, Error, void>({
    mutationFn: () => api.post<{ ok: boolean; devices: number }>('/remote/test'),
  });
}

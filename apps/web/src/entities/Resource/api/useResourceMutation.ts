import type { ResourceKind } from './ResourceApi.types';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { resourceKey } from '../lib/resourceKey';

export function useResourceMutation<TInput, TResult = unknown>(
  kind: ResourceKind,
  id: string,
  request: (input: TInput) => Promise<TResult>,
  successMessage?: string,
  /** Отказ показывает само место вызова, с причиной сервера: общий тост молчит. */
  silentError = false,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: request,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: resourceKey(kind, id) });
      // Список сущностей показывает число файлов и размер — их тоже освежаем.
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
      void queryClient.invalidateQueries({ queryKey: ['scripts'] });
    },
    meta: {
      ...(successMessage ? { successMessage } : {}),
      ...(silentError ? { silentError } : {}),
    },
  });
}

import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { apply } from '../lib/apply';

/** Запись профиля в конфигурацию выбранного CLI. */
export function useApplyEndpoint() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { silentError: true },
    mutationFn: apply,
    onSuccess: () => {
      // Запись меняет файл конфигурации: обновляем разделы окружения и ленту
      // изменений — иначе панель показывала бы состояние до записи.
      void queryClient.invalidateQueries({ queryKey: queryKeys.env });
      void queryClient.invalidateQueries({ queryKey: queryKeys.providerEnv });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
  });
}

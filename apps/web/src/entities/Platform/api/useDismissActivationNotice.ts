import { apiClient } from '@shared/api/client';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function dismissActivationNotice(): Promise<void> {
  await apiClient.delete('/platforms/activation-notice');
}

/**
 * Закрыть рассказ о переносе. Разовый: сервер стирает его у себя, и второй раз
 * он не приедет — иначе он висел бы на экране у человека, который его прочитал.
 */
export function useDismissActivationNotice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: dismissActivationNotice,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.platforms }),
  });
}

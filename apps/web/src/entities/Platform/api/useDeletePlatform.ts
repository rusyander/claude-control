import { apiClient } from '@shared/api/client';
import { path } from '../lib/path';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { invalidateApplied } from '../lib/invalidateApplied';

export async function deletePlatform(id: string): Promise<void> {
  await apiClient.delete(path(id));
}

/** Удалить контур: настройка, ключ и след пробы уходят вместе с применением. */
export function useDeletePlatform() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deletePlatform,
    onSuccess: (_result, id) => invalidateApplied(queryClient, id),
  });
}

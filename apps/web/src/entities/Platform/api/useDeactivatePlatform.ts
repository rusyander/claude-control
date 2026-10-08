import type { PlatformRollbackResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { path } from '../lib/path';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { invalidateApplied } from '../lib/invalidateApplied';

/** Вернуть провайдер по умолчанию: применения снимаются, тумблер гаснет. */
export async function deactivatePlatform(id: string): Promise<PlatformRollbackResult> {
  const { data } = await apiClient.post<PlatformRollbackResult>(path(id, '/deactivate'));
  return data;
}

/**
 * Вернуть провайдер по умолчанию. Один маршрут на две кнопки — на карточке
 * контура и в строке провайдера: «вернуть как было» это одно действие.
 */
export function useDeactivatePlatform({
  silentError = false,
}: {
  /** Отказ показывает вызов сам — общий тост промолчит. */
  silentError?: boolean;
} = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError },
    mutationFn: deactivatePlatform,
    onSuccess: (_result, id) => invalidateApplied(queryClient, id),
  });
}

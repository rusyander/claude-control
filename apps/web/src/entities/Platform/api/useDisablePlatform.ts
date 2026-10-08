import type { PlatformRollbackResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { path } from '../lib/path';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { invalidateApplied } from '../lib/invalidateApplied';

/** Снять применение: целиком либо точечно — одну строку журнала. */
export async function disablePlatform(input: {
  id: string;
  targets?: string[];
}): Promise<PlatformRollbackResult> {
  const { data } = await apiClient.post<PlatformRollbackResult>(
    path(input.id, '/disable'),
    input.targets ? { targets: input.targets } : undefined,
  );
  return data;
}

/**
 * Снять применение: файлы возвращаются в исходный вид, управляемый профиль
 * удаляется. Сам контур остаётся включённым — это разные решения человека.
 */
export function useDisablePlatform() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: disablePlatform,
    onSuccess: (_result, variables) => invalidateApplied(queryClient, variables.id),
  });
}

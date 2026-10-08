import type { PlatformApplyResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { path } from '../lib/path';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { invalidateApplied } from '../lib/invalidateApplied';

export async function applyPlatform(input: {
  id: string;
  targets: string[];
  overwrite?: string[];
  model?: string;
}): Promise<PlatformApplyResult> {
  const { data } = await apiClient.post<PlatformApplyResult>(path(input.id, '/apply'), {
    targets: input.targets,
    overwrite: input.overwrite ?? [],
    ...(input.model === undefined ? {} : { model: input.model }),
  });
  return data;
}

/** Записать контур в названные цели. */
export function useApplyPlatform() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: applyPlatform,
    onSuccess: (_result, variables) => invalidateApplied(queryClient, variables.id),
  });
}

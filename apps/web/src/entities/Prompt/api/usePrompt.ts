import type { PromptId, PromptRecord } from '@agentdeck/contracts/prompts';
import { apiClient } from '@shared/api/client';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function getPrompt(id: PromptId): Promise<PromptRecord> {
  const { data } = await apiClient.get<PromptRecord>(`/prompts/${id}`);
  return data;
}

export function usePrompt(id: PromptId | undefined) {
  return useQuery({
    queryKey: queryKeys.prompt(id ?? ''),
    queryFn: () => getPrompt(id as PromptId),
    enabled: Boolean(id),
  });
}

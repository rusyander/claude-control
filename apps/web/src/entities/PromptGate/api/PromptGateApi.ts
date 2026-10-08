import { useQuery } from '@tanstack/react-query';
import type { PromptGateInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

async function getPromptGate(): Promise<PromptGateInfo> {
  const { data } = await apiClient.get<PromptGateInfo>('/prompt-gate');
  return data;
}

/** Настройки гейта и то, что на самом деле лежит в каталоге хуков. */
export function usePromptGate() {
  return useQuery({ queryKey: queryKeys.promptGate, queryFn: getPromptGate });
}

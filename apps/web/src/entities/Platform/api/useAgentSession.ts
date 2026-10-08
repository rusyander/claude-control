import type { PlatformAgentSession } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { path } from '../lib/path';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function getAgentSession(
  id: string,
  sessionId: string,
): Promise<PlatformAgentSession> {
  const { data } = await apiClient.get<PlatformAgentSession>(
    path(id, `/agents/sessions/${encodeURIComponent(sessionId)}`),
  );
  return data;
}

/**
 * Переписка сессии у КОНТУРА. Своей копии панель не держит — она разошлась бы
 * с той историей, из которой агент на самом деле отвечает.
 */
export function useAgentSession(id: string, sessionId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.platformAgentSession(id, sessionId),
    queryFn: () => getAgentSession(id, sessionId),
    enabled: enabled && id !== '' && sessionId !== '',
  });
}

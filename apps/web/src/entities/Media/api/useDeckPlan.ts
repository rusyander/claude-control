import type { MediaDeckPlan } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { agentQuery } from '../lib/agentQuery';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function getDeckPlan(agent: boolean): Promise<MediaDeckPlan> {
  const { data } = await apiClient.get<MediaDeckPlan>(`/media/decks/plan${agentQuery(agent)}`);
  return data;
}

/** То же для презентации: кто соберёт колоду и получится ли PDF. */
export function useDeckPlan(agent: boolean) {
  return useQuery({
    queryKey: queryKeys.mediaDeckPlan(agent),
    queryFn: () => getDeckPlan(agent),
  });
}

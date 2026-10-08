import { useQuery } from '@tanstack/react-query';
import type { GroupMembersView, MemberDescription } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { PENDING_POLL_MS } from './GroupMembersApi.constants';

/** Участник группы, читаемый на языке интерфейса; `id` — вторичен. */
export type GroupMemberBrief = MemberDescription;

export type { GroupMembersView };

/**
 * Участники группы и шаги её скиллов словами — имя, одна строка «что делает»
 * на двух языках. «Состав», строки «Порядка работы» и их подсказки берут
 * описания отсюда.
 */
export function useGroupMembers(id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.groupMembers(id),
    queryFn: async () => {
      const { data } = await apiClient.get<GroupMembersView>(`/groups/${id}/members`);
      return { ...data, steps: data.steps ?? [] };
    },
    enabled,
    retry: false,
    refetchInterval: (query) =>
      (query.state.data?.pending ?? []).length > 0 ? PENDING_POLL_MS : false,
  });
}

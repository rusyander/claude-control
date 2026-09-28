import { useQuery } from '@tanstack/react-query';
import type {
  GroupMembersView,
  MemberDescription,
  ResourceCatalogView,
} from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/** Участник группы, читаемый на языке интерфейса; `id` — вторичен. */
export type GroupMemberBrief = MemberDescription;

export type { GroupMembersView };

/**
 * Описание идёт моделью в фоне: сервер отвечает сразу тем, что уже описано, а
 * остальное называет в `pending`. Пока список не пуст — спрашиваем снова, как
 * с «числами» скиллов.
 */
const PENDING_POLL_MS = 3000;

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

/**
 * Каталог «Выбрать готовый»: общие скиллы, правила, хуки и утилиты, а с путём
 * проекта — ещё и его ресурсы. Описания докатываются тем же фоновым путём.
 */
export function useResourceCatalog(projectPath: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.groupResourceCatalog(projectPath ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<ResourceCatalogView>('/groups/resource-catalog', {
        params: projectPath ? { path: projectPath } : {},
      });
      return data;
    },
    enabled,
    retry: false,
    refetchInterval: (query) =>
      (query.state.data?.pending ?? []).length > 0 ? PENDING_POLL_MS : false,
  });
}

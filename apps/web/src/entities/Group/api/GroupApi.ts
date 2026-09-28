import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type {
  Group,
  GroupDraft,
  GroupDuplicateRequest,
  GroupDuplicateResult,
} from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { toast } from '@shared/lib/toast';
import type { GroupListItem } from '../model/types';

// Группы живут в данных приложения, а не в конфигах Claude Code,
// поэтому у них свой набор запросов, а не общая CRUD-фабрика сущностей.

async function listGroups(): Promise<GroupListItem[]> {
  const { data } = await apiClient.get<GroupListItem[]>('/groups');
  return data;
}

export function useGroups() {
  return useQuery({ queryKey: queryKeys.groups, queryFn: listGroups });
}

export function useSaveGroup({
  silentError = false,
}: {
  /** Отказ показывает окно само — с причиной сервера; общий тост промолчит. */
  silentError?: boolean;
} = {}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { id?: string; draft: GroupDraft }) => {
      const { id, draft } = input;
      const { data } = id
        ? await apiClient.put<Group>(`/groups/${id}`, { ...draft, id })
        : await apiClient.post<Group>('/groups', draft);
      return data;
    },
    onSuccess: (saved) => {
      // Сохранённая группа — в список сразу, до перечитывания: следующая правка,
      // собранная из списка (быстрый выбор шага), иначе строилась бы по старому
      // составу и молча теряла только что добавленного участника.
      queryClient.setQueryData<Group[]>(queryKeys.groups, (list) =>
        list?.map((item) => (item.id === saved.id ? saved : item)),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    },
    meta: { successMessage: 'toasts.saved', silentError },
  });
}

/**
 * Переключатель группы гасит и зажигает все её участники сразу, поэтому
 * устаревает не только список групп: правила, скиллы, хуки, MCP-серверы и
 * права меняют состояние вместе с ней.
 */
function invalidateGroupMembers(queryClient: ReturnType<typeof useQueryClient>): void {
  for (const key of [
    queryKeys.groups,
    queryKeys.rules,
    queryKeys.skills,
    queryKeys.hooks,
    queryKeys.mcp,
    queryKeys.permissions,
    queryKeys.overview,
  ]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

export function useSetGroupEnabled() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: async (input: { id: string; isEnabled: boolean }) => {
      const { data } = await apiClient.post<{
        ok: true;
        affected: number;
        skippedLocalHooks?: number;
      }>(`/groups/${input.id}/enabled`, { isEnabled: input.isEnabled });
      return data;
    },
    onSuccess: (data) => {
      invalidateGroupMembers(queryClient);
      // Хук из settings.local.json группе не подчиняется: панель в этот файл не
      // пишет. Молчать об этом нельзя — человек считал бы, что выключил его.
      if (data.skippedLocalHooks)
        toast.warning(t('groups.localHooksSkipped', { count: data.skippedLocalHooks }));
    },
    meta: { successMessage: 'toasts.updated' },
  });
}

/**
 * «Копировать группу»: независимая выключенная копия рядом с оригиналом.
 * Имя уходит готовым — окно показывает ровно то, под которым копия ляжет.
 * Участники копии не гасятся (сервер кладёт запись без отметок), поэтому
 * устаревает только список групп.
 */
export function useDuplicateGroup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { id: string } & GroupDuplicateRequest) => {
      const { id, ...body } = input;
      const { data } = await apiClient.post<GroupDuplicateResult>(`/groups/${id}/duplicate`, body);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    },
  });
}

export function useDeleteGroup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/groups/${id}`);
    },
    // Удаление выключенной группы отпускает её участников, поэтому обновляем
    // их списки тем же способом, что и переключатель.
    onSuccess: () => invalidateGroupMembers(queryClient),
    meta: { successMessage: 'toasts.deleted' },
  });
}

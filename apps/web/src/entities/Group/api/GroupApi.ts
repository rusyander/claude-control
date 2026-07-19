import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Automation, Group, GroupDraft } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Группы и сценарии живут в данных приложения, а не в конфигах Claude Code,
// поэтому у них свой набор запросов, а не общая CRUD-фабрика сущностей.

async function listGroups(): Promise<Group[]> {
  const { data } = await apiClient.get<Group[]>('/groups');
  return data;
}

async function listAutomations(): Promise<Automation[]> {
  const { data } = await apiClient.get<Automation[]>('/automations');
  return data;
}

export function useGroups() {
  return useQuery({ queryKey: queryKeys.groups, queryFn: listGroups });
}

export function useAutomations() {
  return useQuery({ queryKey: queryKeys.automations, queryFn: listAutomations });
}

export function useSaveGroup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { id?: string; draft: GroupDraft }) => {
      const { id, draft } = input;
      const { data } = id
        ? await apiClient.put<Group>(`/groups/${id}`, { ...draft, id })
        : await apiClient.post<Group>('/groups', draft);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    },
    meta: { successMessage: 'toasts.saved' },
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

  return useMutation({
    mutationFn: async (input: { id: string; isEnabled: boolean }) => {
      const { data } = await apiClient.post<{ ok: true; affected: number }>(
        `/groups/${input.id}/enabled`,
        { isEnabled: input.isEnabled },
      );
      return data;
    },
    onSuccess: () => invalidateGroupMembers(queryClient),
    meta: { successMessage: 'toasts.updated' },
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

export function useSaveAutomation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { id?: string; automation: Omit<Automation, 'id'> }) => {
      const { id, automation } = input;
      const { data } = id
        ? await apiClient.put<Automation>(`/automations/${id}`, { ...automation, id })
        : await apiClient.post<Automation>('/automations', automation);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations });
      // Сценарий компилируется в хук, поэтому список хуков тоже устаревает.
      void queryClient.invalidateQueries({ queryKey: queryKeys.hooks });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}

export function useDeleteAutomation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/automations/${id}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations });
      void queryClient.invalidateQueries({ queryKey: queryKeys.hooks });
    },
    meta: { successMessage: 'toasts.deleted' },
  });
}

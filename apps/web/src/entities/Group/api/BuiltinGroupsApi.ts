import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BuiltinGroupsRestoreResult, BuiltinGroupsStatus } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/** Удалённые и изменённые человеком встроенные группы — для кнопки и пометки карточки. */
export function useBuiltinGroups() {
  return useQuery({
    queryKey: queryKeys.groupBuiltin,
    queryFn: async () => {
      const { data } = await apiClient.get<BuiltinGroupsStatus>('/groups/builtin');
      return data;
    },
  });
}

/** «Вернуть встроенные»: снимает отказ человека и засевает удалённые заново. */
export function useRestoreBuiltinGroups() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<BuiltinGroupsRestoreResult>('/groups/builtin/restore');
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    },
  });
}

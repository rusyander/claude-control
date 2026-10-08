import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { GroupDuplicateRequest, GroupDuplicateResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

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

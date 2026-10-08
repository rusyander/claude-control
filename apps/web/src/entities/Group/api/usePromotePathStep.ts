import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { PathResourceType, GroupPathView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/** Шаг становится скиллом, хуком или правилом и входит в группу участником. */
export function usePromotePathStep(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { stepId: string; type: PathResourceType; draft: string }) => {
      const { data } = await apiClient.post<GroupPathView>(`/groups/${id}/path/promote`, input);
      return data;
    },
    onSuccess: (view) => {
      queryClient.setQueryData(queryKeys.groupPath(id), view);
      for (const key of [queryKeys.groups, queryKeys.skills, queryKeys.rules, queryKeys.hooks]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    meta: { successMessage: 'groupPath.promoted' },
  });
}

import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { invalidateGroupMembers } from '../lib/invalidateGroupMembers';

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

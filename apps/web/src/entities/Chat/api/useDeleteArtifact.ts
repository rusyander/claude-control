import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { chatKeys } from './ChatApi.constants';

/**
 * Удалить артефакт из папки чата. Доступно только у чатов песочницы: их файлы
 * лежат в отдельной папке панели, и убрать лишнее там безопасно. После удаления
 * перечитываем список артефактов.
 */
export function useDeleteArtifact(chatId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (name: string) => {
      await apiClient.delete(`/chat/${chatId}/artifact`, { params: { name } });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.artifacts(chatId ?? '') });
    },
  });
}

import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { GroupDraft, Group } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

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

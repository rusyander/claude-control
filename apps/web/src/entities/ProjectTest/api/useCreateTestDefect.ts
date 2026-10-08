import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

export function useCreateTestDefect(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      groupId: string;
      caseId: string;
      /**
       * Куда заводить. Строка, а не закрытый список: целей у сервера стало
       * больше, чем `gh`/`glab` (Jira, фордж по токену), и держать их перечень
       * на фронте значит обновлять его вслед за сервером в двух местах. Что
       * доступно на самом деле, говорит `draft.targets`.
       */
      target: string;
      title: string;
      body: string;
    }) => {
      const { data } = await apiClient.post<{ url: string }>('/project-tests/defect/create', {
        path,
        ...payload,
      });
      return data.url;
    },
    // Ссылка на заведённый дефект дописывается в кейс — список после этого другой.
    onSuccess: () => void client.invalidateQueries({ queryKey: testKeys.view(path) }),
  });
}

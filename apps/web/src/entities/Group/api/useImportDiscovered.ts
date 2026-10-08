import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { Group } from '@agentdeck/contracts';
import { queryKeys } from '@shared/api/query-keys';

export function useImportDiscovered() {
  const queryClient = useQueryClient();
  return useMutation({
    // `lang` — язык интерфейса: имя и «Когда» новой группы берутся на нём.
    mutationFn: async ({ key, lang }: { key: string; lang?: 'ru' | 'en' }) => {
      const { data } = await apiClient.post<Group>(
        `/groups/discovery/${encodeURIComponent(key)}/import`,
        lang ? { lang } : {},
      );
      return data;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.groups }),
    meta: { successMessage: 'groupSources.imported' },
  });
}

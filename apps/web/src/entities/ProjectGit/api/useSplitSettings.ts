import { useQuery } from '@tanstack/react-query';
import { splitSettingsKeyFor } from '../lib/splitSettingsKeyFor';
import { apiClient } from '@shared/api/client';
import type { SplitSettingsView } from '@agentdeck/contracts/task-split';

/**
 * Доставка до MR на проекте: включена ли, сколько групп разделения идёт разом и
 * что панель узнала о проекте сама (удалённый репозиторий, навык, подготовка копии).
 */
export function useSplitSettings(path: string | undefined) {
  return useQuery({
    queryKey: splitSettingsKeyFor(path),
    queryFn: async () => {
      const { data } = await apiClient.get<SplitSettingsView>('/project-git/split-settings', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
  });
}

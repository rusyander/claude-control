import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { LocalConnectInfo } from '@agentdeck/contracts/local-models';
import { queryKeys } from '@shared/api/query-keys';
import { post } from '../lib/post';

/**
 * Кнопка локальной модели в шапке чата. Кроме снимка раздела перечитывается и ветка
 * контуров: от неё зависит, что шапка чата скажет о модели прогона, и без этого выбор
 * модели ещё десять секунд показывал бы облако после включения.
 */
export function useToggleLocal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { on: boolean; tag?: string }) =>
      post<LocalConnectInfo>('/local-models/toggle', input),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.localModels }),
        queryClient.invalidateQueries({ queryKey: queryKeys.platforms }),
      ]);
    },
  });
}

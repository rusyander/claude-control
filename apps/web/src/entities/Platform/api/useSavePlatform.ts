import type { Platform, PlatformStatus, PlatformsInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { path } from '../lib/path';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { PLATFORM_SAVE_KEY } from './PlatformApi.constants';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Сохранить контур. Ключ едет РЯДОМ с настройкой и только когда его тронули:
 * форма правки поля ключа не присылает вовсе, и сохранённый остаётся на месте.
 */
export async function savePlatform(input: {
  platform: Platform;
  token?: string;
}): Promise<PlatformStatus> {
  const { data } = await apiClient.put<PlatformStatus>(path(input.platform.id), {
    settings: input.platform,
    ...(input.token === undefined ? {} : { token: input.token }),
  });
  return data;
}

/** Сохранить контур целиком (и ключ, если его тронули). */
export function useSavePlatform({
  silentError = false,
}: {
  /** Отказ показывает вызов сам — общий тост промолчит. */
  silentError?: boolean;
} = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError },
    mutationFn: savePlatform,
    mutationKey: PLATFORM_SAVE_KEY,
    // Писатели контура (разделы на карточке, «чьи правила», поля правил) шлют
    // PUT полной заменой, каждый собирает контур из снимка списка. Сохранения
    // идут по одному, а снимок обновляется сразу по щелчку: иначе второй
    // переключатель, щёлкнутый до перечитывания списка, собирал контур из
    // старого снимка и молча откатывал первый (ревью 28.09 F-83).
    scope: { id: 'platform-save' },
    onMutate: async ({ platform }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.platforms });
      const put = (status: PlatformStatus) =>
        status.platform.id === platform.id ? { ...status, platform } : status;
      queryClient.setQueryData<PlatformsInfo>(
        queryKeys.platforms,
        (info) => info && { ...info, platforms: info.platforms.map(put) },
      );
    },
    // Отказ — снимок с сервера: оптимистичная правка не должна остаться на экране.
    onError: () => void queryClient.invalidateQueries({ queryKey: queryKeys.platforms }),
    onSuccess: (_status, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.platforms });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.platformApply(variables.platform.id),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.platformGateway });
    },
  });
}

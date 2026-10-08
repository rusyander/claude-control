import type { PlatformActivationResult } from '@agentdeck/contracts';
import { apiClient, LONG_TIMEOUTS } from '@shared/api/client';
import { path } from '../lib/path';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { invalidateApplied } from '../lib/invalidateApplied';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Сделать контур активным. Запрос ходит в сеть дважды (проба и пробный запрос
 * через свой же шлюз), поэтому таймаут — свой: общих 60 с не хватает контуру,
 * который думает над ответом, а оборванный браузером запрос выглядел бы как
 * «активация не удалась» при удавшейся активации.
 */
export async function activatePlatform(id: string): Promise<PlatformActivationResult> {
  const { data } = await apiClient.post<PlatformActivationResult>(
    path(id, '/activate'),
    undefined,
    { timeout: LONG_TIMEOUTS.platformActivate },
  );
  return data;
}

/**
 * Сделать контур активным.
 *
 * Сбрасывается не только карточка: активация СНИМАЕТ применения прежнего
 * контура — то есть меняет переменные окружения CLI, управляемый профиль в
 * настройках и историю правок. Прежний контур назван в ответе, и его
 * предпросмотр применения сбрасывается отдельно: иначе он продолжал бы
 * показывать записанное, которого в файлах уже нет.
 */
export function useActivatePlatform({
  silentError = false,
}: {
  /** Отказ показывает вызов сам — общий тост промолчит. */
  silentError?: boolean;
} = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError },
    mutationFn: activatePlatform,
    onSuccess: (result, id) => {
      invalidateApplied(queryClient, id);
      if (result.previousPlatformId) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.platformApply(result.previousPlatformId),
        });
      }
    },
    // Отказ перечитывается ТАК ЖЕ. Сервер возвращает состояние к прежнему сам,
    // но «прежнее» — это его состояние, а не наш снимок: активацию мог увести
    // другой вкладкой или телефоном, и тогда отказ означает, что экран устарел
    // весь. Оставить его как есть — значит показывать вчерашнюю картину до F5.
    onError: (_error, id) => invalidateApplied(queryClient, id),
  });
}

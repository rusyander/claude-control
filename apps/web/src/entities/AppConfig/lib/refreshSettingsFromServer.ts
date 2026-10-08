import type { QueryClient } from '@tanstack/react-query';
import type { AppSettings } from '@agentdeck/contracts';
import { queryKeys } from '@shared/api/query-keys';
import { getSettings } from './getSettings';
import { changedSettings } from './changedSettings';
import { applySettingsUpdate } from './applySettingsUpdate';

/**
 * Настройки сменили СНАРУЖИ — в соседней вкладке, с телефона, агентом панели
 * (сервер шлёт раздел `settings` по потоку событий). Перечитываем и
 * раскладываем разницу тем же путём, что и свой PATCH: язык и тема применятся
 * сразу, смена провайдера сбросит разделы чужого CLI. Своё же эхо разницы не
 * даёт — кеш уже содержит ответ собственного PATCH.
 */
export async function refreshSettingsFromServer(queryClient: QueryClient): Promise<void> {
  const before = queryClient.getQueryData<AppSettings>(queryKeys.settings);
  const after = await queryClient.fetchQuery({
    queryKey: queryKeys.settings,
    queryFn: getSettings,
    staleTime: 0,
  });
  if (!before) return;
  const patch = changedSettings(before, after);
  if (Object.keys(patch).length > 0) applySettingsUpdate(queryClient, after, patch);
}

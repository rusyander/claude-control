import { useQueryClient, useMutation } from '@tanstack/react-query';
import { patchSettings } from '../lib/patchSettings';
import { sendSettingsPatch, type SettingsPatchInput } from '../lib/sendSettingsPatch';

export function useUpdateSettings({
  silentError = false,
}: {
  /** Отказ показывает вызов сам — общий тост промолчит. */
  silentError?: boolean;
} = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError },
    // Правка ложится в кеш сразу, запросы уходят по очереди — см. sendSettingsPatch.
    mutationFn: (patch: SettingsPatchInput) => sendSettingsPatch(queryClient, patch, patchSettings),
  });
}

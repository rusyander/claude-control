import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { AppSettingsPatch } from '@agentdeck/contracts';
import { patchSettings } from '../lib/patchSettings';
import { sendSettingsPatch } from '../lib/sendSettingsPatch';

export function useUpdateSettings({
  silentError = false,
}: {
  /** Отказ показывает вызов сам — общий тост промолчит. */
  silentError?: boolean;
} = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError },
    // Ответ раскладывается внутри: порядок ответов сверяется с порядком отправки.
    mutationFn: (patch: AppSettingsPatch) => sendSettingsPatch(queryClient, patch, patchSettings),
  });
}

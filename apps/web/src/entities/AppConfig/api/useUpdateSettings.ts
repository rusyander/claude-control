import { useQueryClient, useMutation } from '@tanstack/react-query';
import { applySettingsUpdate } from '../lib/applySettingsUpdate';
import { patchSettings } from '../lib/patchSettings';

export function useUpdateSettings({
  silentError = false,
}: {
  /** Отказ показывает вызов сам — общий тост промолчит. */
  silentError?: boolean;
} = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError },
    mutationFn: patchSettings,
    onSuccess: (settings, variables) => {
      applySettingsUpdate(queryClient, settings, variables);
    },
  });
}

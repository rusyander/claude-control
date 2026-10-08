import { useMutation } from '@tanstack/react-query';
import type { PluginScaffoldRequest, PluginScaffoldResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { toast } from '@shared/lib/toast';
import { i18n } from '@shared/config/i18n';

/**
 * Скаффолдер плагина: создаёт каркас в выбранной папке. Как и CLI-команды,
 * сервер возвращает исход полем ok, поэтому итог (успех или причину отказа)
 * разбираем здесь, а не в глобальном обработчике сетевых ошибок.
 */
export function useScaffoldPlugin() {
  return useMutation({
    mutationFn: async (input: PluginScaffoldRequest): Promise<PluginScaffoldResult> => {
      const { data } = await apiClient.post<PluginScaffoldResult>('/plugins/scaffold', input);
      return data;
    },
    onSuccess: (result) => {
      if (result.ok) toast.success(i18n.t('toasts.pluginScaffolded'));
      else toast.error(result.error?.trim() || i18n.t('plugins.commandFailed'));
    },
  });
}

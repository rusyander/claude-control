import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProviderExtensionActionResult } from './ProviderPluginsApi.types';
import { apiClient } from '@shared/api/client';
import { infoKey } from '../lib/infoKey';

/**
 * Расширения Qwen Code (MAP 25): установить, включить/выключить, удалить. Панель
 * только зовёт `qwen extensions …` на сервере — файлы она здесь не пишет. Уровень
 * один, глобальный: проектного каталога расширений у Qwen нет.
 */
export function useInstallProviderExtension() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (source: string): Promise<ProviderExtensionActionResult> => {
      const { data } = await apiClient.post<ProviderExtensionActionResult>(
        '/provider-plugins/installed',
        { source },
      );
      return data;
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: infoKey() }),
    meta: { successMessage: 'toasts.pluginInstalled' },
  });
}

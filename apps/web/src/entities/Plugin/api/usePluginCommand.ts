import type { CommandResult } from '@agentdeck/contracts';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { pluginsKey } from './PluginApi.constants';
import { toast } from '@shared/lib/toast';
import { i18n } from '@shared/config/i18n';

/**
 * Операции с плагинами идут через CLI и занимают секунды: он клонирует
 * репозиторий маркетплейса. Поэтому таймаут увеличен, а список обновляется
 * только после завершения команды.
 */
export function usePluginCommand<TInput>(
  request: (input: TInput) => Promise<CommandResult>,
  successMessage: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: request,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: pluginsKey });
      // У CLI-команд ошибка приходит не исключением, а полем ok=false —
      // поэтому итог разбираем здесь, а не в глобальном обработчике.
      if (result.ok) toast.success(i18n.t(successMessage));
      else toast.error(result.output?.trim() || i18n.t('plugins.commandFailed'));
    },
    // Тост об успехе/ошибке команды ставим сами (по ok). Брошенные (сетевые)
    // ошибки при этом по-прежнему подхватит глобальный обработчик.
  });
}

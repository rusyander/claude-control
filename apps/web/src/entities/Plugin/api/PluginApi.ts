import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CommandResult,
  Plugin,
  PluginsState,
  PluginScaffoldRequest,
  PluginScaffoldResult,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { i18n } from '@shared/config/i18n';
import { toast } from '@shared/lib/toast';

const pluginsKey = ['plugins'] as const;

async function getPlugins(): Promise<PluginsState> {
  const { data } = await apiClient.get<PluginsState>('/plugins');
  return data;
}

export function usePlugins() {
  return useQuery({ queryKey: pluginsKey, queryFn: getPlugins });
}

/**
 * Каталог маркетплейсов. Запрос идёт в сеть и обновляет репозитории — это
 * десятки секунд, поэтому он не выполняется сам: страница запрашивает каталог
 * только когда пользователь его открыл, и потом держит в кеше.
 */
export function useAvailablePlugins(isEnabled: boolean) {
  return useQuery({
    queryKey: ['plugins', 'available'],
    queryFn: async () => {
      const { data } = await apiClient.get<Plugin[]>('/plugins/available', { timeout: 300_000 });
      return data;
    },
    enabled: isEnabled,
    staleTime: 30 * 60 * 1000,
  });
}

/**
 * Операции с плагинами идут через CLI и занимают секунды: он клонирует
 * репозиторий маркетплейса. Поэтому таймаут увеличен, а список обновляется
 * только после завершения команды.
 */
function usePluginCommand<TInput>(
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

export function useInstallPlugin() {
  return usePluginCommand(async (id: string) => {
    const { data } = await apiClient.post<CommandResult>(
      '/plugins/install',
      { id },
      { timeout: 300_000 },
    );
    return data;
  }, 'toasts.pluginInstalled');
}

export function useUninstallPlugin() {
  return usePluginCommand(async (id: string) => {
    const { data } = await apiClient.post<CommandResult>(
      `/plugins/${encodeURIComponent(id)}/uninstall`,
      {},
      { timeout: 300_000 },
    );
    return data;
  }, 'toasts.pluginRemoved');
}

export function useSetPluginEnabled() {
  return usePluginCommand(async (input: { id: string; isEnabled: boolean }) => {
    const { data } = await apiClient.post<CommandResult>(
      `/plugins/${encodeURIComponent(input.id)}/enabled`,
      { isEnabled: input.isEnabled },
      { timeout: 120_000 },
    );
    return data;
  }, 'toasts.updated');
}

export function useUpdatePlugin() {
  return usePluginCommand(async (id: string) => {
    const { data } = await apiClient.post<CommandResult>(
      `/plugins/${encodeURIComponent(id)}/update`,
      {},
      { timeout: 300_000 },
    );
    return data;
  }, 'toasts.pluginUpdated');
}

export function useAddMarketplace() {
  return usePluginCommand(async (source: string) => {
    const { data } = await apiClient.post<CommandResult>(
      '/plugins/marketplaces',
      { source },
      { timeout: 300_000 },
    );
    return data;
  }, 'toasts.marketplaceAdded');
}

export function useRemoveMarketplace() {
  return usePluginCommand(async (name: string) => {
    const { data } = await apiClient.delete<CommandResult>(
      `/plugins/marketplaces/${encodeURIComponent(name)}`,
      { timeout: 120_000 },
    );
    return data;
  }, 'toasts.marketplaceRemoved');
}

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

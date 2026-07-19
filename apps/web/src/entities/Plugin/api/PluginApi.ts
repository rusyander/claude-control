import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommandResult, Plugin, PluginsState } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';

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
function usePluginCommand<TInput>(request: (input: TInput) => Promise<CommandResult>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: request,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: pluginsKey });
    },
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
  });
}

export function useUninstallPlugin() {
  return usePluginCommand(async (id: string) => {
    const { data } = await apiClient.post<CommandResult>(
      `/plugins/${encodeURIComponent(id)}/uninstall`,
      {},
      { timeout: 300_000 },
    );
    return data;
  });
}

export function useSetPluginEnabled() {
  return usePluginCommand(async (input: { id: string; isEnabled: boolean }) => {
    const { data } = await apiClient.post<CommandResult>(
      `/plugins/${encodeURIComponent(input.id)}/enabled`,
      { isEnabled: input.isEnabled },
      { timeout: 120_000 },
    );
    return data;
  });
}

export function useUpdatePlugin() {
  return usePluginCommand(async (id: string) => {
    const { data } = await apiClient.post<CommandResult>(
      `/plugins/${encodeURIComponent(id)}/update`,
      {},
      { timeout: 300_000 },
    );
    return data;
  });
}

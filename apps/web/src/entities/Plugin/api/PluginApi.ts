import { useQuery } from '@tanstack/react-query';
import type { PluginsState } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { pluginsKey } from './PluginApi.constants';

async function getPlugins(): Promise<PluginsState> {
  const { data } = await apiClient.get<PluginsState>('/plugins');
  return data;
}

export function usePlugins() {
  return useQuery({ queryKey: pluginsKey, queryFn: getPlugins });
}

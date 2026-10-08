import type { Scope } from './ProviderPluginsApi.types';
import { useQuery } from '@tanstack/react-query';
import { fileKey } from '../lib/fileKey';
import type { ProviderPluginFileContent } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { basePath } from '../lib/basePath';

/** Содержимое одного файла плагина — как есть, панель его ничем не разбирает. */
export function useProviderPluginFile(path: string | undefined, { projectId }: Scope = {}) {
  return useQuery({
    queryKey: fileKey(path ?? '', projectId),
    enabled: Boolean(path),
    queryFn: async (): Promise<ProviderPluginFileContent> => {
      const { data } = await apiClient.get<ProviderPluginFileContent>(
        `${basePath(projectId)}/file`,
        { params: { path } },
      );
      return data;
    },
  });
}

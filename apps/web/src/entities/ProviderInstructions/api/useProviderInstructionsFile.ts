import type { Scope } from './ProviderInstructionsApi.types';
import { useQuery } from '@tanstack/react-query';
import { fileKey } from '../lib/fileKey';
import type { ProviderInstructionsFile } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { basePath } from '../lib/basePath';

/**
 * Содержимое ОДНОГО перечисленного файла. Запрос включается только когда запись
 * выбрана и её файл существует: панель не создаёт файлов, которых нет.
 */
export function useProviderInstructionsFile(raw: string | undefined, { projectId }: Scope = {}) {
  return useQuery({
    queryKey: fileKey(raw ?? '', projectId),
    enabled: Boolean(raw),
    queryFn: async (): Promise<ProviderInstructionsFile> => {
      const { data } = await apiClient.get<ProviderInstructionsFile>(
        `${basePath(projectId)}/file`,
        { params: { path: raw } },
      );
      return data;
    },
  });
}

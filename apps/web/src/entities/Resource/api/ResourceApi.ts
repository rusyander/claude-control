import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { ResourceKind } from './ResourceApi.types';
import { resourceKey } from '../lib/resourceKey';

export interface ResourceFile {
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  /** Двоичный файл показываем, но не даём править текстом. */
  isBinary: boolean;
}

export interface ResourceFiles {
  files: ResourceFile[];
  /** Можно ли менять состав: у плагинов файлы чужие. */
  isWritable: boolean;
  /** Файл, который стоит открыть первым. */
  entryFile?: string;
}

export function useResourceFiles(kind: ResourceKind, id: string | undefined) {
  return useQuery({
    queryKey: resourceKey(kind, id ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<ResourceFiles>(
        `/resources/${kind}/${encodeURIComponent(id ?? '')}/files`,
      );
      return data;
    },
    enabled: Boolean(id),
  });
}

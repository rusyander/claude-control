import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { scriptsKey } from './ScriptApi.constants';

export interface ScriptFile {
  id: string;
  name: string;
  extension: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  description?: string;
  isUsed: boolean;
  /** Тест или фикстура (`tests/`, `*.test.*`): к хукам не привязывают по замыслу. */
  isTest: boolean;
}

export function useScripts() {
  return useQuery({
    queryKey: scriptsKey,
    queryFn: async () => {
      const { data } = await apiClient.get<ScriptFile[]>('/scripts');
      return data;
    },
  });
}

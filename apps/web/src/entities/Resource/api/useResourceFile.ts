import type { ResourceKind } from './ResourceApi.types';
import { useQuery } from '@tanstack/react-query';
import { resourceKey } from '../lib/resourceKey';
import { apiClient } from '@shared/api/client';
import type { CodedFields } from '@agentdeck/contracts/server-messages';

export function useResourceFile(kind: ResourceKind, id: string | undefined, file?: string) {
  return useQuery({
    queryKey: [...resourceKey(kind, id ?? ''), 'file', file],
    queryFn: async () => {
      const { data } = await apiClient.get<
        { content: string; isBinary: boolean } & CodedFields<'content'>
      >(`/resources/${kind}/${encodeURIComponent(id ?? '')}/file`, { params: { file } });
      return data;
    },
    enabled: Boolean(id && file),
  });
}

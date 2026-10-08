import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { encodeScriptId } from '../lib/encodeScriptId';

/** Содержимое файла грузится отдельно: список не должен тянуть весь код. */
export function useScriptContent(id: string | undefined) {
  return useQuery({
    queryKey: ['scripts', id, 'content'],
    queryFn: async () => {
      const { data } = await apiClient.get<{ content: string }>(
        `/scripts/${encodeScriptId(id ?? '')}`,
      );
      return data.content;
    },
    enabled: Boolean(id),
  });
}

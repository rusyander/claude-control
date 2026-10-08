import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { CliUpdateResult } from '@agentdeck/contracts';
import { KEY } from './ChatCliApi.constants';

/** `<cli> update` запускаемой копией; ответ несёт свежие сведения. */
export function useUpdateChatCli(provider?: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<CliUpdateResult>('/chat/cli/update', undefined, {
        params: provider ? { provider } : {},
      });
      return data;
    },
    // Итог говорит сама кнопка (успех или хвост вывода) — общий тост не нужен.
    meta: { silentError: true },
    onSuccess: (result) => {
      client.setQueryData([...KEY, provider ?? 'active', true], result.info);
      client.setQueryData([...KEY, provider ?? 'active', false], result.info);
    },
  });
}

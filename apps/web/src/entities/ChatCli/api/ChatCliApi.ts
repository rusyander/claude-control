import { useQuery } from '@tanstack/react-query';
import type { CliInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { KEY } from './ChatCliApi.constants';

/** Сведения о CLI. `refresh` — мимо пятиминутного кеша сервера (карточка ошибки). */
export function useChatCli(
  options: { enabled?: boolean; refresh?: boolean; provider?: string } = {},
) {
  return useQuery({
    queryKey: [...KEY, options.provider ?? 'active', options.refresh === true],
    queryFn: async () => {
      const { data } = await apiClient.get<CliInfo>('/chat/cli', {
        params: {
          ...(options.refresh ? { refresh: '1' } : {}),
          ...(options.provider ? { provider: options.provider } : {}),
        },
      });
      return data;
    },
    enabled: options.enabled !== false,
    staleTime: 60_000,
  });
}

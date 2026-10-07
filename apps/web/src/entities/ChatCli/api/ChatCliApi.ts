import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CliInfo, CliUpdateResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

/**
 * CLI, которым панель ведёт чаты (по умолчанию — активного провайдера, `provider`
 * — явно чей: карточка ошибки чата Claude спрашивает про `claude`) (замечание живого прогона 25.09.2026:
 * панель молча запускала старую копию из PATH, и модель отказывалась с ней
 * работать). Путь, версия, соседняя копия новее — и обновление именно той
 * копии, которую панель запускает.
 */

const KEY = ['chat', 'cli'] as const;

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

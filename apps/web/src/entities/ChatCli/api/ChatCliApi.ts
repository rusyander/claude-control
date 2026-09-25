import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CliInfo, CliUpdateResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

/**
 * CLI Claude, которым панель ведёт чаты (замечание живого прогона 25.09.2026:
 * панель молча запускала старую копию из PATH, и модель отказывалась с ней
 * работать). Путь, версия, соседняя копия новее — и обновление именно той
 * копии, которую панель запускает.
 */

const KEY = ['chat', 'cli'] as const;

/** Сведения о CLI. `refresh` — мимо пятиминутного кеша сервера (карточка ошибки). */
export function useChatCli(options: { enabled?: boolean; refresh?: boolean } = {}) {
  return useQuery({
    queryKey: [...KEY, options.refresh === true],
    queryFn: async () => {
      const { data } = await apiClient.get<CliInfo>('/chat/cli', {
        params: options.refresh ? { refresh: '1' } : {},
      });
      return data;
    },
    enabled: options.enabled !== false,
    staleTime: 60_000,
  });
}

/** `claude update` запускаемой копией; ответ несёт свежие сведения. */
export function useUpdateChatCli() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<CliUpdateResult>('/chat/cli/update');
      return data;
    },
    // Итог говорит сама кнопка (успех или хвост вывода) — общий тост не нужен.
    meta: { silentError: true },
    onSuccess: (result) => {
      client.setQueryData([...KEY, true], result.info);
      client.setQueryData([...KEY, false], result.info);
    },
  });
}

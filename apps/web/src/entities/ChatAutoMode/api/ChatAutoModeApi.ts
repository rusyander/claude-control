import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatAutoModeView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

/**
 * Авторежим прав чата — сторона клиента (владелец, 24.09.2026).
 *
 * Выбор живёт на СЕРВЕРЕ, а не в браузере: прогоны чата заводит и панель сама
 * (продолжения, звенья), без вкладки, и браузерный тумблер до них не доходил.
 * Глобальное положение — настройка панели `chatAutoMode`; щелчок в чате —
 * выбор этого чата, сильнее глобального в обе стороны.
 */

const KEY = ['chat', 'auto-mode'] as const;

export function useChatAutoMode(chatId: string | undefined, sessionId?: string) {
  return useQuery({
    queryKey: [...KEY, chatId ?? '', sessionId ?? ''],
    queryFn: async () => {
      const { data } = await apiClient.get<ChatAutoModeView>(
        `/chat/${encodeURIComponent(chatId ?? '')}/auto-mode`,
        { params: sessionId ? { sessionId } : {} },
      );
      return data;
    },
    enabled: Boolean(chatId),
  });
}

/** Выбрать авторежим в этом чате. Идущий прогон получает его сразу же. */
export function useSetChatAutoMode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { chatId: string; enabled: boolean }) => {
      await apiClient.post(`/chat/${encodeURIComponent(input.chatId)}/auto-approve`, {
        enabled: input.enabled,
      });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: KEY }),
  });
}

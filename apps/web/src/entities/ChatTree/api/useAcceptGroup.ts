import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { SplitGroupAccepted } from '@agentdeck/contracts/chat-handoff';

/**
 * «Принять» доставленную группу и «Снять отметку» (`accepted: false`). Приёмка
 * ручная: отметку ставит только эта кнопка, а не факты доставки. Повтор
 * безопасен — сервер оставляет первое время приёмки.
 */
export function useAcceptGroup() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index: number; accepted: boolean }) => {
      const { data } = await apiClient.post<SplitGroupAccepted>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/accept`,
        { index: input.index, accepted: input.accepted },
      );
      return data;
    },
  });
}

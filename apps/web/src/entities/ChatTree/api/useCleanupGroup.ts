import { apiClient } from '@shared/api/client';
import type { SplitGroupCleaned } from '@agentdeck/contracts/chat-handoff';
import { useMutation } from '@tanstack/react-query';

/**
 * Убрать копию закрытой группы (Д19) — по кнопке человека: панель сама не
 * удаляет ничего. Ветка уходит с копией, только если пустая. Адресуется
 * РОДИТЕЛЮ с номером группы — как ответ и «отпустить». Группа прошлого
 * разделения (F5.2) — чатом: её номер от старого плана и занят новой группой.
 */
export const cleanupGroupMutation = {
  mutationFn: async (
    input: { parentChatId: string } & ({ index: number } | { chatId: string }),
  ) => {
    const { data } = await apiClient.post<SplitGroupCleaned>(
      `/chat/split/${encodeURIComponent(input.parentChatId)}/cleanup`,
      'chatId' in input ? { chatId: input.chatId } : { index: input.index },
    );
    return data;
  },
};

export function useCleanupGroup() {
  return useMutation({ ...cleanupGroupMutation, meta: { silentError: true } });
}

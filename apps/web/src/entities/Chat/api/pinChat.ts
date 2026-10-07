import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ChatSummary } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { chatKeys } from './ChatApi';

export interface PinChatInput {
  chatId: string;
  pinned: boolean;
}

/** Метка закрепления в кэше списка — сразу, не дожидаясь перечитывания. */
export function withPin(chats: ChatSummary[] | undefined, input: PinChatInput, at: string) {
  return chats?.map((chat) => {
    if (chat.id !== input.chatId) return chat;
    if (input.pinned) return { ...chat, pinnedAt: at };
    const { pinnedAt: _dropped, ...rest } = chat;
    return rest;
  });
}

/**
 * Закрепить разговор в списке или открепить (владелец, 07.10.2026).
 *
 * Список меняется сразу: закрепление — жест раскладки, и ждать сервера, чтобы
 * строка уехала наверх, незачем. Отказ сервера возвращает прежний список и
 * показывается общим тостом; после ответа список перечитывается — правда
 * остаётся за сервером, он хранит закрепления и для телефона.
 */
export function usePinChat() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: PinChatInput) => {
      await apiClient.put(`/chats/${encodeURIComponent(input.chatId)}/pin`, {
        pinned: input.pinned,
      });
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: chatKeys.list, exact: true });
      const before = queryClient.getQueryData<ChatSummary[]>(chatKeys.list);
      queryClient.setQueryData<ChatSummary[]>(chatKeys.list, (chats) =>
        withPin(chats, input, new Date().toISOString()),
      );
      return { before };
    },
    onError: (_error, _input, context) => {
      if (context?.before) queryClient.setQueryData(chatKeys.list, context.before);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.list, exact: true });
    },
  });
}

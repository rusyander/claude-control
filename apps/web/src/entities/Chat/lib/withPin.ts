import type { ChatSummary } from '@agentdeck/contracts';
import type { PinChatInput } from '../api/pinChat.types';

/** Метка закрепления в кэше списка — сразу, не дожидаясь перечитывания. */
export function withPin(chats: ChatSummary[] | undefined, input: PinChatInput, at: string) {
  return chats?.map((chat) => {
    if (chat.id !== input.chatId) return chat;
    if (input.pinned) return { ...chat, pinnedAt: at };
    const { pinnedAt: _dropped, ...rest } = chat;
    return rest;
  });
}

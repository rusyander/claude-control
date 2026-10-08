import type { ProviderChatStatus } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';

/** Состояние хода сейчас, без ожидания. */
export function fetchForeignStatus(chatId: string): Promise<ProviderChatStatus> {
  return api.get<ProviderChatStatus>(`/provider-chat/chats/${encodeURIComponent(chatId)}/status`);
}

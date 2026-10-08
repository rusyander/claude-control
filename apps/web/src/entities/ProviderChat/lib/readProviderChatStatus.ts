import type { ProviderChatStatus } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

/** Что происходит прямо сейчас — этим вкладка догоняет пропущенное после F5. */
export async function readProviderChatStatus(chatId: string): Promise<ProviderChatStatus> {
  const { data } = await apiClient.get<ProviderChatStatus>(`/provider-chat/chats/${chatId}/status`);
  return data;
}

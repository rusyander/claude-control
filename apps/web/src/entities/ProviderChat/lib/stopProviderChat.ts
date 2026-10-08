import { apiClient } from '@shared/api/client';

export async function stopProviderChat(chatId: string): Promise<void> {
  await apiClient.post(`/provider-chat/chats/${chatId}/stop`);
}

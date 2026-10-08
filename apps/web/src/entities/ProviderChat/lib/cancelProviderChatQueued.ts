import { apiClient } from '@shared/api/client';

/** Убрать сообщение из очереди; `false` — оно уже ушло. */
export async function cancelProviderChatQueued(chatId: string, queuedId: string): Promise<boolean> {
  const { data } = await apiClient.delete<{ cancelled: boolean }>(
    `/provider-chat/chats/${chatId}/queue/${queuedId}`,
  );
  return data.cancelled;
}

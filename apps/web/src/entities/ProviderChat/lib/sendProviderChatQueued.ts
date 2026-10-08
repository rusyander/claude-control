import type { ProviderChatMessage } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

/**
 * «Отправить» у ждущей очереди (Ф13): ход остановили или панель
 * перезапускалась — сообщение уходит обычной отправкой.
 */
export async function sendProviderChatQueued(
  chatId: string,
  queuedId: string,
): Promise<{ message: ProviderChatMessage }> {
  const { data } = await apiClient.post<{ message: ProviderChatMessage }>(
    `/provider-chat/chats/${chatId}/queue/${queuedId}/send`,
  );
  return data;
}

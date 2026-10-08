import { apiClient } from '@shared/api/client';

/** Ответ человека на просьбу CLI о разрешении (карточка в ленте). */
export async function answerProviderChatPermission(
  chatId: string,
  askId: string,
  decision: 'allow' | 'deny',
): Promise<void> {
  await apiClient.post(`/provider-chat/chats/${chatId}/permissions/${askId}`, { decision });
}

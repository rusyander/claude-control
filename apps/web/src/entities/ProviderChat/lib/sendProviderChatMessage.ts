import type { ProviderChatMessage, ProviderChatQueued } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

/**
 * Задать вопрос. Ответ придёт потоком — здесь возвращается записанная реплика.
 * Разговор занят, а `queueIfBusy` — сервер ставит сообщение в очередь (202) и
 * возвращает её элемент: сообщение уйдёт само по концу идущего ответа. Если у
 * CLI есть вход посреди ответа (В1), реплику подхватывает идущий ход —
 * `{ message, steered: true }`.
 */
export async function sendProviderChatMessage(
  chatId: string,
  input: { text: string; attachments?: string[]; queueIfBusy?: boolean },
): Promise<{ message: ProviderChatMessage; steered?: true } | { queued: ProviderChatQueued }> {
  const { data } = await apiClient.post<
    { message: ProviderChatMessage; steered?: true } | { queued: ProviderChatQueued }
  >(`/provider-chat/chats/${chatId}/send`, input);
  return data;
}

import type { ChatNames } from './model.types';

/**
 * Имя карточки для списка: сессия, пока она есть, — она не меняется ни с
 * началом хода со стола, ни с его концом, и начатый ответ не сбрасывается.
 * До сессии — ключ прогона: вопрос раньше первой записи CLI не задаёт.
 */
export function stableChatKey(chat: ChatNames): string {
  return chat.sessionId ?? chat.runKey ?? chat.id;
}

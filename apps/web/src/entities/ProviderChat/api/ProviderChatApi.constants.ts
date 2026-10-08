/**
 * Переписка с чужим провайдером. Отдельный набор маршрутов, не пересекающийся с
 * чатом Claude: там источник правды — транскрипты самого CLI, здесь переписку
 * ведёт панель, потому что своей читаемой истории у этих CLI нет.
 */

export const providerChatKeys = {
  list: ['provider-chats'] as const,
  detail: (id: string) => ['provider-chats', id] as const,
  // Свой корень, а не `['provider-chats', 'projects']`: тот совпал бы с
  // карточкой разговора по id «projects».
  projects: ['provider-chat-projects'] as const,
};

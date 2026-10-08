export const foreignKeys = {
  all: ['provider-chat'] as const,
  list: (providerId: string) => ['provider-chat', providerId, 'list'] as const,
  chat: (providerId: string, chatId: string) => ['provider-chat', providerId, chatId] as const,
  status: (providerId: string, chatId: string) =>
    ['provider-chat', providerId, chatId, 'status'] as const,
};

/** Список разговоров живёт дольше: новые появляются редко. */
export const LIST_POLL_MS = 10_000;

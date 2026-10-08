export const chatKeys = {
  list: ['chats'] as const,
  /** Разговоры деревьев, ждущие человека, — из памяти сервера. */
  awaiting: ['chats', 'awaiting'] as const,
  messages: (id: string) => ['chats', id, 'messages'] as const,
  artifacts: (id: string) => ['chats', id, 'artifacts'] as const,
  progress: (id: string) => ['chats', id, 'progress'] as const,
  /** Поиск по телу переписки: ключ зависит от запроса — кешируем по строке. */
  search: (query: string) => ['chats', 'search', query] as const,
  /** Отпечаток транскрипта: по нему видно, что разговор дописали. */
  version: (id: string) => ['chats', id, 'version'] as const,
};

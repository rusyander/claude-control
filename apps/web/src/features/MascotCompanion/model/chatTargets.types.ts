/** Разговор, в который Дека может отвести человека. */
export interface ChatTarget {
  chatId: string;
  /** Заголовок разговора или имя каталога; пусто — не знаем, как назвать. */
  name: string;
  projectPath?: string;
  isSandbox?: boolean;
}

export interface CompanionLists {
  waiting: ChatTarget[];
  errors: ChatTarget[];
  running: ChatTarget[];
}

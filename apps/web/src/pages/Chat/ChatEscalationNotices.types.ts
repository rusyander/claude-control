export interface ChatEscalationNoticesProps {
  /** Ключ разговора во вкладке — `new-…` до первого хода. */
  chatId: string | undefined;
  /** Настоящий ключ разговора, когда прогон его уже назвал. */
  sessionId?: string;
  /** Открыть чат ребёнка разделения, от которого пришла заметка. */
  onOpenChild: (childChatId: string) => void;
}

export interface FeedScrollSignals {
  /** Разговор на экране: по его смене лента прокручивается к последнему. */
  conversationId?: string;
  /** Число сообщений: рост снизу — ехать за ответом; после подгрузки — вернуть позицию. */
  messageCount: number;
  /** Что ещё растит ленту снизу: идущий ответ, его вызовы, обрыв потока, запросы прав. */
  streamText: string;
  streamToolCount: number;
  stalled?: boolean;
  permissionCount?: number;
}

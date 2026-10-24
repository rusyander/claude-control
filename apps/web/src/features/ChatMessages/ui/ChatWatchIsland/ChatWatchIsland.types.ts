export interface ChatWatchIslandProps {
  /** Ключ открытого разговора в панели; нет — острова нет. */
  chatId?: string | undefined;
  /** Сессия CLI того же разговора: сторож мог записать сигнал под ней. */
  sessionId?: string | undefined;
}

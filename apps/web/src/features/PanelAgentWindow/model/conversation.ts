// Лента разговора живёт в контрактах: её же зовёт телефон (А8).
export {
  EMPTY_CONVERSATION,
  applyRunEvent,
  fromConversation,
  isOwnConversationEvent,
  reloadSettledConversation,
  withNotice,
  withReloadedConversation,
  withSealedTurnCaughtUp,
  withTurnAborted,
  withUserMessage,
  sealNoteFrom,
} from '@agentdeck/contracts/panel-agent-feed';
export type { ConversationState, FeedItem, SealNote } from '@agentdeck/contracts/panel-agent-feed';

/**
 * Ждущие карточки окна: свои — этого разговора, чужие — другой вкладки, телефона
 * или прошлого разговора. Список ожиданий у панели общий, и без разделения чужая
 * карточка вставала в новый разговор как своя: её отклоняли, не зная, чья она.
 */
export function splitPending<T extends { conversationId?: string }>(
  pending: readonly T[],
  isOwn: (conversationId: string | undefined) => boolean,
): { own: T[]; foreign: T[] } {
  const own: T[] = [];
  const foreign: T[] = [];
  for (const card of pending) (isOwn(card.conversationId) ? own : foreign).push(card);
  return { own, foreign };
}

/**
 * Открывает ли пришедшая карточка окно. Только своя: чужая (другая вкладка,
 * телефон, второе окно) видна на значке кнопки — на узком экране окно закрывало
 * страницу, на которой человек работал, ради просьбы, которую он не задавал.
 */
export function pendingOpensWindow(
  card: { conversationId?: string },
  isOwn: (conversationId: string | undefined) => boolean,
): boolean {
  return isOwn(card.conversationId);
}

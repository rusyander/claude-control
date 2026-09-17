// Лента разговора живёт в контрактах: её же зовёт телефон (А8).
export {
  EMPTY_CONVERSATION,
  applyRunEvent,
  fromConversation,
  withNotice,
  withTurnAborted,
  withUserMessage,
} from '@agentdeck/contracts/panel-agent-feed';
export type { ConversationState, FeedItem } from '@agentdeck/contracts/panel-agent-feed';

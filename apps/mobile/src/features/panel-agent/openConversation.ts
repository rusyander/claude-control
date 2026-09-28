import {
  EMPTY_CONVERSATION,
  fromConversation,
  withNotice,
  type ConversationState,
  type SealNote,
} from '@agentdeck/contracts/panel-agent-feed';
import type { PanelAgentConversation } from '@agentdeck/contracts/panel-agent';

/**
 * Открыть разговор из истории. Всегда даёт состояние: сбой загрузки — пустой
 * разговор со строкой ошибки. Раньше отказ уходил из `open()` наружу, вызов на
 * экране не ловил его, и нажатие на разговор тихо ничего не делало (F-369).
 */
export async function openConversation(input: {
  load: () => Promise<PanelAgentConversation>;
  sealNote: SealNote | undefined;
  failed: (message: string) => string;
}): Promise<ConversationState> {
  try {
    return fromConversation(await input.load(), input.sealNote);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return withNotice(EMPTY_CONVERSATION, 'error', input.failed(message));
  }
}

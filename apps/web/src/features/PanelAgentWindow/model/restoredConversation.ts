import type { PanelAgentConversation } from '@agentdeck/contracts/panel-agent';
import type { SealNote, ConversationState } from './conversation';
import { fromConversation, withNotice } from './conversation';

/**
 * Разговор после перезагрузки. Ход, который шёл в момент перезагрузки, уже
 * остановлен сервером, и последняя реплика человека осталась без ответа —
 * `fromConversation` не отправит её повторно; заметка объясняет почему.
 */
export function restoredConversation(
  conversation: PanelAgentConversation,
  turnOpen: boolean,
  interruptedNote: string,
  sealNote?: SealNote,
): ConversationState {
  const state = fromConversation(conversation, sealNote);
  return turnOpen ? withNotice(state, 'error', interruptedNote) : state;
}

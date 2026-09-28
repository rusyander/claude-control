import type { InboxChat } from '@agentdeck/contracts/chat-inbox';
import { findRunKey } from '../../shared/lib/runs';

/**
 * Под каким ключом этот разговор живёт в памяти телефона. Прогон, подхваченный
 * опросом или начатый отсюда, записан под своим ключом, а сводка называет чат
 * по сессии: открыв или ответив под другим именем, телефон завёл бы второй
 * прогон на тот же разговор и не увидел бы живого потока.
 */
export function localChatKey(chat: Pick<InboxChat, 'id' | 'runKey' | 'sessionId'>): string {
  return findRunKey(chat.runKey, chat.sessionId, chat.id) ?? chat.sessionId ?? chat.id;
}

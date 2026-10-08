import type { ChatNames } from './model.types';
import type { InboxAsk } from '@agentdeck/contracts/chat-inbox';

/**
 * Ключи отправленного ответа — с чатом: `toolUseId` уникален лишь внутри
 * разговора. Одного имени у чата нет: `id` — ключ прогона, пока нет сессии,
 * потом id сессии (F-190), а ключ прогона появляется с ходом и пропадает с его
 * концом — у вопроса из транскрипта и при ходе со стола (D2). Ответ помечается
 * под КАЖДЫМ именем, которое чат носит в момент отправки, и скрыт, пока чат
 * носит хоть одно из них: иначе отвеченная карточка возвращалась, и на неё
 * можно было ответить второй раз.
 */
export function sentKeys(chat: ChatNames, ask: Pick<InboxAsk, 'key'>): string[] {
  const names = new Set([chat.sessionId, chat.runKey, chat.id].filter(Boolean));
  return [...names].map((name) => `${name}\u0000${ask.key}`);
}

import { parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { ServerContext } from '../../context.ts';
import type { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { readChats } from '../../domains/chat/ChatHistory/ChatHistory.ts';
import { readChat } from '../../domains/provider-chat/store/store.ts';
import { projectsDir } from '../../routes/chat/paths.ts';

/**
 * Имя чата по ключу прогона — вторая строка уведомления Telegram и строки
 * `/status`. Порядок как у сводки ожиданий: имя группы из связи разговора,
 * затем заголовок разговора (его пишет Claude Code или первое сообщение). Чат
 * чужого CLI — по его записи панели. Не нашлось — `undefined`, строки нет.
 *
 * Ключ прогона бывает временным (`new-…`): тогда разговор ищется по сессии,
 * которую реестр уже за ним записал.
 */
export function chatTitleOf(
  ctx: ServerContext,
  registry: Pick<ChatRunRegistry, 'active'>,
  chatId: string,
): string | undefined {
  const foreign = parseForeignChatKey(chatId);
  if (foreign) {
    return readChat(ctx.location.paths.appData, foreign.providerId, foreign.chatId)?.title;
  }
  const sessionId = registry.active().find((run) => run.chatId === chatId)?.sessionId;
  const keys = sessionId && sessionId !== chatId ? [chatId, sessionId] : [chatId];
  for (const key of keys) {
    const linked = ctx.store.getChatLink(key)?.title;
    if (linked) return linked;
  }
  const chats = readChats(projectsDir(ctx));
  for (const key of keys) {
    const title = chats.find((chat) => chat.id === key)?.title;
    if (title) return title;
  }
  return undefined;
}

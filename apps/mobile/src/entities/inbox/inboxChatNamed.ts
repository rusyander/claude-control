import type { InboxChat } from '@agentdeck/contracts/chat-inbox';

/** Строка сводки этого разговора — по любому имени, под которым его открыли. */
export function inboxChatNamed(
  chats: readonly InboxChat[],
  ...names: (string | undefined)[]
): InboxChat | undefined {
  const wanted = names.filter((name): name is string => Boolean(name));
  return chats.find((chat) =>
    [chat.id, chat.runKey, chat.sessionId].some((name) => name && wanted.includes(name)),
  );
}

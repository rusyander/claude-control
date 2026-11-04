import type { foreignChatRu } from './ru';

/** English mirror of `ru.ts`, typed against it. */
export const foreignChatEn: typeof foreignChatRu = {
  section: (cli: string) => `${cli} conversations`,
  nothing: 'No conversations yet',
  messages: (count: number) => `${count} msg.`,
  notFound: 'Conversation not found: it was deleted or belongs to another panel.',
  you: 'You',
  notice: 'Panel',
  failed: 'No answer',
  steered: 'taken mid-answer',
  coreOnly: (cli: string) =>
    `These are the conversations the panel kept before the chat moved to the core. A new chat with ${cli} starts in the panel: section «Chat», button «New».`,
  history: (cli: string) =>
    `Read-only: the panel kept this conversation before the chat moved to the core, and it cannot go on in the same ${cli} session. A new chat starts in the panel: section «Chat», button «New».`,
};

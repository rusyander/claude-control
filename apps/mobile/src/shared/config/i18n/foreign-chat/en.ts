import type { foreignChatRu } from './ru';

/** English mirror of `ru.ts`, typed against it. */
export const foreignChatEn: typeof foreignChatRu = {
  section: (cli: string) => `${cli} conversations`,
  newChat: (cli: string) => `New conversation with ${cli}`,
  nothing: 'No conversations yet',
  messages: (count: number) => `${count} msg.`,
  notFound: 'Conversation not found: it was deleted or belongs to another panel.',
  you: 'You',
  notice: 'Panel',
  failed: 'No answer',
  steered: 'taken mid-answer',
  typing: 'Answering…',
  placeholder: 'Message',
  send: 'Send',
  steer: 'Pass into the answer',
  queue: 'Queue',
  stop: 'Stop',
  sendFailed: 'Not sent',
  queued: 'Waiting for the answer to end',
  queueHeld: 'The answer was stopped — the queue will not go by itself.',
  sendQueued: 'Send',
  permission: 'The CLI asks for permission',
  allow: 'Allow',
  deny: 'Deny',
  edits: {
    allowed: 'Edits without asking (the switch is in the panel)',
    ask: 'Edits wait for your answer on the card',
    denied: 'Edits blocked (the switch is in the panel)',
    cli: (cli: string) => `${cli} decides on edits itself, by its own settings`,
  },
  readOnly: (cli: string, active: string) =>
    `This is a ${cli} conversation, and the panel's active CLI is ${active}. You can read it; to reply, switch to ${cli} in the panel.`,
};

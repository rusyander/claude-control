import type { InboxChat } from '@agentdeck/contracts/chat-inbox';

export type ChatNames = Pick<InboxChat, 'id' | 'runKey' | 'sessionId'>;

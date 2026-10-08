import type { ChatInbox } from '@agentdeck/contracts/chat-inbox';
import { api } from '../../shared/api/client';

export function inboxQuery(): { queryKey: unknown[]; queryFn: () => Promise<ChatInbox> } {
  return {
    // Под `chat`: конец хода на экране чата перечитывает всё `['chat']` — и
    // сводку тоже, без отдельного вызова.
    queryKey: ['chat', 'inbox'],
    queryFn: () => api.get<ChatInbox>('/chat/inbox'),
  };
}

import type { InboxChat } from '@agentdeck/contracts/chat-inbox';
import { copyOwner, pathKey } from '../../entities/project/projectList';

export interface ProjectLive {
  running: number;
  waiting: number;
}

/**
 * Что сейчас идёт в каждом проекте — по сводке главной (`/chat/inbox`), без
 * второго опроса. Ход в копии ветки засчитывается её проекту: человек ищет
 * в списке проект, а не каталог копии.
 */
export function projectLive(chats: readonly InboxChat[]): Map<string, ProjectLive> {
  const live = new Map<string, ProjectLive>();
  for (const chat of chats) {
    if (chat.status === 'idle' || !chat.projectPath) continue;
    const owner = copyOwner(chat.projectPath);
    const keys = [pathKey(chat.projectPath), ...(owner ? [pathKey(owner.main)] : [])];
    for (const key of keys) {
      const entry = live.get(key) ?? { running: 0, waiting: 0 };
      if (chat.status === 'running') entry.running += 1;
      else entry.waiting += 1;
      live.set(key, entry);
    }
  }
  return live;
}

/** Статус одного разговора по сводке главной; разговора там нет — молчит. */
export function chatStatus(
  chats: readonly InboxChat[],
  id: string,
): InboxChat['status'] | undefined {
  return chats.find((chat) => chat.id === id || chat.sessionId === id)?.status;
}

import type { InboxChat, InboxChatStatus } from '@agentdeck/contracts/chat-inbox';
import { byImportance } from './byImportance';
import { visibleAsks } from './visibleAsks';

export interface ProjectGroup {
  /** Ключ группы — путь основной копии, у песочницы свой. */
  key: string;
  name: string;
  path: string;
  isSandbox: boolean;
  chats: InboxChat[];
  waiting: number;
  running: number;
  /** Свежайшее движение в группе. */
  updatedAt: string;
}

export const SANDBOX_GROUP = 'sandbox';

/**
 * Чаты по проектам. Проект — основная копия: разговор в git-копии числится за
 * ней, иначе один проект распадался бы на столько групп, сколько у него копий.
 * Порядок внутри и между группами — по тому, кто важнее человеку сейчас: сперва
 * ждущие ответа, потом идущие, потом свежие по времени.
 */
export function projectGroups(
  chats: readonly InboxChat[],
  sent: ReadonlySet<string> = new Set(),
): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const raw of chats) {
    const chat = withoutSent(raw, sent);
    const path = chat.homeProjectPath ?? chat.projectPath;
    const key = chat.isSandbox ? SANDBOX_GROUP : groupPathKey(path) || chat.project;
    const group = groups.get(key) ?? {
      key,
      name: chat.project,
      path,
      isSandbox: chat.isSandbox,
      chats: [],
      waiting: 0,
      running: 0,
      updatedAt: chat.updatedAt,
    };
    group.chats.push(chat);
    // Одно состояние на чат: ждущий ответа и при этом работающий считается
    // ждущим, иначе один чат давал бы «ждут: 1 · работают: 1».
    if (chat.status === 'waiting') group.waiting += 1;
    else if (chat.status === 'running') group.running += 1;
    if (chat.updatedAt > group.updatedAt) group.updatedAt = chat.updatedAt;
    groups.set(key, group);
  }
  for (const group of groups.values()) group.chats.sort(byImportance);
  return [...groups.values()].sort(
    (a, b) =>
      rankOf(a) - rankOf(b) || b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key),
  );
}

/**
 * Ключ пути для группы. Регистр сводится только у путей Windows: на сервере
 * Linux `/srv/Repo` и `/srv/repo` — два проекта, и нижний регистр склеивал их
 * в одну группу с именем того, кто пришёл первым (F-151).
 */
function groupPathKey(path: string): string {
  const isWindows = /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\');
  const trimmed = path.replace(/[\\/]+$/, '');
  return isWindows ? trimmed.replace(/\\/g, '/').toLowerCase() : trimmed;
}

/**
 * Чат глазами телефона: отправленное отсюда уже не ждёт. Без этого вкладка
 * «Вопросы» пустела сразу после «Отправить», а строка чата ещё говорила «ждёт
 * ответа · 1 вопрос» — до следующего опроса сервера (F-153).
 */
function withoutSent(chat: InboxChat, sent: ReadonlySet<string>): InboxChat {
  const asks = visibleAsks(chat, sent);
  if (asks.length === chat.asks.length) return chat;
  const status = chat.status === 'waiting' && asks.length === 0 ? idleOrRunning(chat) : chat.status;
  return { ...chat, asks, status };
}

const idleOrRunning = (chat: InboxChat): InboxChatStatus => (chat.running ? 'running' : 'idle');

function rankOf(group: ProjectGroup): number {
  if (group.waiting > 0) return 0;
  if (group.running > 0) return 1;
  return 2;
}

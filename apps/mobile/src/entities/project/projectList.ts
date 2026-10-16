import type { Project } from '@agentdeck/contracts';
import type {
  ChatProject,
  ProjectChatEntry,
  ProjectEntry,
  ProjectLists,
} from './projectList.types';

/** Суффикс каталога копий — тот же, что у сервера (`domains/project-git/worktrees.ts`). */
const WORKTREES_SUFFIX = '-worktrees';

/**
 * Ключ сравнения путей. Реестр и история пишут один каталог по-разному: `c:\work\x`
 * и `C:\work\x`, с косой в конце и без, — а на Windows это одна папка. Без
 * нормализации проект из реестра показывался бы «без разговоров», хотя их десятки.
 */
export function pathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Последний сегмент пути — имя папки для подписи. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Копия ветки живёт рядом с репозиторием: `<родитель>/<имя>-worktrees/<копия>`.
 * Её разговоры — работа над тем же проектом, и в списке они должны быть при нём,
 * а не отдельной строкой на каждую ветку: иначе за неделю их набирается десяток.
 */
export function copyOwner(path: string): { main: string; copy: string } | undefined {
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  if (parts.length < 3) return undefined;
  const copy = parts[parts.length - 1] ?? '';
  const holder = parts[parts.length - 2] ?? '';
  if (!holder.endsWith(WORKTREES_SUFFIX) || holder.length === WORKTREES_SUFFIX.length) {
    return undefined;
  }
  const main = [...parts.slice(0, -2), holder.slice(0, -WORKTREES_SUFFIX.length)].join('/');
  return { main, copy };
}

function chatsOf(project: ChatProject, copy?: string): ProjectChatEntry[] {
  return project.chats
    .filter((chat) => !chat.isSandbox)
    .map((chat) => ({
      id: chat.id,
      title: chat.title,
      updatedAt: chat.updatedAt,
      messageCount: chat.messageCount,
      messageCountPartial: chat.messageCountPartial,
      path: project.path,
      ...(copy ? { copy } : {}),
    }));
}

function byFreshness(a: { updatedAt: string }, b: { updatedAt: string }): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

/**
 * Список проектов для телефона: реестр панели — основа, разговоры к нему
 * приклеиваются из истории по пути (свои и копий). История одна сама по себе
 * для этого не годится: в ней каждая временная папка, где хоть раз запускался
 * агент, и настоящие проекты тонут среди них.
 */
export function buildProjectLists(
  registry: readonly Project[],
  history: readonly ChatProject[],
): ProjectLists {
  const entries = new Map<string, ProjectEntry>();
  for (const project of registry) {
    const key = pathKey(project.path);
    if (entries.has(key)) continue;
    entries.set(key, {
      path: project.path,
      name: project.name || baseName(project.path),
      registered: true,
      exists: true,
      lastActivity: '',
      chats: [],
    });
  }

  const outside = new Map<string, ProjectEntry>();
  const attach = (target: ProjectEntry, chats: ProjectChatEntry[], at: string): void => {
    target.chats.push(...chats);
    if (at > target.lastActivity) target.lastActivity = at;
  };

  for (const project of history) {
    const own = entries.get(pathKey(project.path));
    if (own) {
      own.exists = project.exists;
      attach(own, chatsOf(project), project.lastActivity);
      continue;
    }
    const owner = copyOwner(project.path);
    const holder = owner ? entries.get(pathKey(owner.main)) : undefined;
    if (owner && holder) {
      attach(holder, chatsOf(project, owner.copy), project.lastActivity);
      continue;
    }
    // Вне реестра: папка, которой больше нет, человеку ни к чему — открыть её нельзя.
    if (!project.exists) continue;
    const chats = chatsOf(project);
    if (chats.length === 0) continue;
    const key = pathKey(project.path);
    const known = outside.get(key);
    if (known) {
      attach(known, chats, project.lastActivity);
      continue;
    }
    outside.set(key, {
      path: project.path,
      name: baseName(project.path),
      registered: false,
      exists: true,
      lastActivity: project.lastActivity,
      chats,
    });
  }

  const order = (a: ProjectEntry, b: ProjectEntry): number => {
    if (a.lastActivity && b.lastActivity) return b.lastActivity.localeCompare(a.lastActivity);
    if (a.lastActivity || b.lastActivity) return a.lastActivity ? -1 : 1;
    return a.name.localeCompare(b.name);
  };
  const finish = (list: ProjectEntry[]): ProjectEntry[] =>
    list.map((entry) => ({ ...entry, chats: [...entry.chats].sort(byFreshness) })).sort(order);

  return { mine: finish([...entries.values()]), others: finish([...outside.values()]) };
}

/** Фильтр по строке поиска: имя и путь, без учёта регистра. */
export function matchesQuery(entry: ProjectEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${entry.name} ${entry.path}`.toLowerCase().includes(needle);
}

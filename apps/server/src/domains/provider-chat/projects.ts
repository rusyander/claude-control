import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderChatProject, ProviderChatProjectProvider } from '@agentdeck/contracts';
import { isNonProject, listProjects, normalizePath, shortName } from '../chat/ChatProjects.ts';
import { isSandboxPath } from '../chat/ChatArtifacts.ts';
import { projectDirProblem } from '../projects.ts';
import { listChats } from './store.ts';

/**
 * Все проекты для чата чужого провайдера: каталоги, где работали Claude (его
 * транскрипты, `listProjects`) и любой другой CLI (рабочий каталог разговоров
 * панели, `<appData>/provider-chats/<провайдер>/`).
 *
 * Зачем объединять, а не показывать каждому провайдеру своё: чат чужого CLI
 * знал только собственные разговоры, и при смене провайдера все проекты,
 * начатые с Claude, пропадали из вида. Ключ — нормализованный путь (тот же
 * `normalizePath`, что у списка Claude): один каталог пишется по-разному, а
 * строка у него должна быть одна, с перечнем провайдеров.
 *
 * Каталог, которого больше нет, НЕ выбрасывается (в отличие от списка проектов
 * Claude): здесь строка несёт причину, по которой новый разговор в нём не
 * начать, — иначе проект молча исчезал бы, и непонятно почему.
 */
export interface ProjectsSources {
  /** Каталог транскриптов Claude (`<config>/projects`). */
  projectsDir: string;
  /** Каталог состояния панели — там лежат разговоры чужих CLI. */
  appDataDir: string;
  /** Имя провайдера для бейджа; домен реестра провайдеров не знает. */
  providerName: (providerId: string) => string;
}

/** Провайдеры, у которых в панели есть разговоры (имена каталогов `provider-chats`). */
function foreignProviderIds(appDataDir: string): string[] {
  const root = join(appDataDir, 'provider-chats');
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // Нечитаемый каталог разговоров не должен прятать проекты Claude.
    return [];
  }
}

interface Draft {
  path: string;
  lastActivity: string;
  providers: Map<string, ProviderChatProjectProvider>;
}

export function listAllProjects(sources: ProjectsSources): ProviderChatProject[] {
  const byPath = new Map<string, Draft>();

  const add = (path: string, providerId: string, chatCount: number, at: string): void => {
    const key = normalizePath(path);
    let draft = byPath.get(key);
    if (!draft) {
      draft = { path, lastActivity: at, providers: new Map() };
      byPath.set(key, draft);
    } else if (at > draft.lastActivity) {
      // Написание пути — от самого свежего источника: им и продолжают работу.
      draft.path = path;
      draft.lastActivity = at;
    }
    const known = draft.providers.get(providerId);
    if (known) {
      known.chatCount += chatCount;
      if (at > known.lastActivity) known.lastActivity = at;
    } else {
      draft.providers.set(providerId, {
        id: providerId,
        name: sources.providerName(providerId),
        chatCount,
        lastActivity: at,
      });
    }
  };

  for (const project of listProjects(sources.projectsDir)) {
    add(project.path, 'claude', project.chats.length, project.lastActivity);
  }

  for (const providerId of foreignProviderIds(sources.appDataDir)) {
    for (const chat of listChats(sources.appDataDir, providerId)) {
      const path = chat.workdir;
      // Разговор без каталога идёт в каталоге сервера — проектом это не считается;
      // песочницы и черновики отсеиваются тем же правилом, что у Claude.
      if (!path || isSandboxPath(path) || isNonProject(path)) continue;
      add(path, providerId, 1, chat.updatedAt);
    }
  }

  return [...byPath.values()]
    .map((draft): ProviderChatProject => {
      const problem = projectDirProblem(draft.path);
      return {
        path: draft.path,
        name: shortName(draft.path),
        lastActivity: draft.lastActivity,
        providers: [...draft.providers.values()].sort((a, b) =>
          b.lastActivity.localeCompare(a.lastActivity),
        ),
        ...(problem ? { startProblem: problem } : {}),
      };
    })
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

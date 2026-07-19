import { existsSync } from 'node:fs';
import { readChats } from './ChatHistory.ts';
import { isSandboxPath } from './ChatArtifacts.ts';

/**
 * Перечисление проектов, с которыми работал Claude Code.
 *
 * Транскрипты уже разложены по каталогам проектов в ~/.claude/projects, и в
 * каждом чате записан его рабочий путь (`projectPath`). Поэтому список проектов
 * не требует отдельного обхода диска: он выводится из уже прочитанных чатов —
 * группировкой по каталогу. Так список проектов и список чатов всегда сходятся.
 *
 * Из выборки убираем: песочницы самой панели (это не проекты пользователя) и
 * временные черновики агента во временном каталоге ОС.
 */

export interface ProjectChatRef {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  isSandbox: boolean;
}

export interface ProjectInfo {
  /** Абсолютный путь каталога проекта — как записан в транскриптах. */
  path: string;
  /** Короткое имя для интерфейса — последние сегменты пути. */
  name: string;
  /** Существует ли каталог на диске сейчас (иначе продолжать работу негде). */
  exists: boolean;
  /** Последняя активность по всем чатам проекта, ISO. */
  lastActivity: string;
  /** Сессии, которые велись в этом проекте, — свежие первыми. */
  chats: ProjectChatRef[];
}

/** Нормализация пути для дедупликации: один каталог пишется по-разному. */
function normalizePath(path: string): string {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

/** Короткое имя проекта — два последних сегмента пути. */
function shortName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || path;
}

/**
 * Отсев того, что проектом пользователя не является:
 *  - песочница панели в любом расположении (её каталог мог смениться, и старый
 *    `isSandboxPath` его уже не узнаёт — ловим по устойчивому признаку пути);
 *  - временные черновики агента во временном каталоге ОС и scratchpad;
 *  - служебные подкаталоги (`.agent`, скриншоты), а не корни проектов.
 */
function isNonProject(path: string): boolean {
  return (
    /[\\/]claude-control[\\/]chats[\\/]/i.test(path) ||
    /[\\/]chats[\\/](?:new|qa)-/i.test(path) ||
    /[\\/](?:AppData[\\/]Local[\\/]Temp|Temp|tmp)[\\/].*claude/i.test(path) ||
    /[\\/]scratchpad(?:[\\/]|$)/i.test(path) ||
    /[\\/](?:\.agent|screenshots|before-after)(?:[\\/]|$)/i.test(path)
  );
}

/**
 * Проекты, сгруппированные из истории чатов. Отсортированы по свежести
 * последней активности. Внутри каждого — его чаты, тоже свежие первыми
 * (порядок наследуется из `readChats`, который уже сортирует по времени).
 */
export function listProjects(projectsDir: string): ProjectInfo[] {
  const byPath = new Map<string, ProjectInfo>();

  for (const chat of readChats(projectsDir)) {
    const path = chat.projectPath;
    if (!path) continue;
    // Песочницы панели, временные черновики агента и служебные подкаталоги — не проекты.
    if (chat.isSandbox || isSandboxPath(path) || isNonProject(path)) continue;

    const key = normalizePath(path);
    let project = byPath.get(key);
    if (!project) {
      project = {
        path,
        name: shortName(path),
        exists: existsSync(path),
        lastActivity: chat.updatedAt,
        chats: [],
      };
      byPath.set(key, project);
    }

    project.chats.push({
      id: chat.id,
      title: chat.title,
      updatedAt: chat.updatedAt,
      messageCount: chat.messageCount,
      isSandbox: chat.isSandbox,
    });
    if (chat.updatedAt > project.lastActivity) project.lastActivity = chat.updatedAt;
  }

  return [...byPath.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

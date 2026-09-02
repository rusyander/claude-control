import { existsSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project, ProjectDraft } from '@claude-control/contracts';

/**
 * Проектный уровень конфигурации. Панель ведёт не только пользовательский
 * `~/.claude`, но и конфиги конкретного проекта. Пути внутри его каталога —
 * стандартные для Claude Code:
 *
 *   - правила       → `<dir>/CLAUDE.md`
 *   - права и хуки  → `<dir>/.claude/settings.json` (+ `.claude/settings.local.json`)
 *   - MCP-серверы   → `<dir>/.mcp.json` (в корне репозитория)
 *
 * Каталога `.claude` в проекте может ещё не быть — он создаётся при первой записи
 * (это делает `writeTextFile`, создающий недостающие каталоги). Формат файлов тот
 * же, что и на пользовательском уровне, поэтому чтение и запись переиспользуют
 * существующие доменные функции (`readRules`/`readMcpServers`/`readPermissions`
 * и их пары на запись), просто с проектными путями.
 */

/** Набор путей к конфигам одного проекта. */
export interface ProjectPaths {
  /** Корень проекта. */
  root: string;
  /** `<dir>/CLAUDE.md` — правила проекта. */
  claudeMd: string;
  /** `<dir>/.claude/settings.json` — права и хуки проекта. */
  settings: string;
  /** `<dir>/.claude/settings.local.json` — личные права и хуки проекта. */
  settingsLocal: string;
  /** `<dir>/.mcp.json` — MCP-серверы проекта (в корне репозитория). */
  mcpConfig: string;
}

/** Проблема с каталогом проекта или null, если он пригоден. */
export function checkProjectDir(path: string): string | null {
  if (!path.trim()) return 'Путь к проекту не задан';
  if (!isAbsolute(path)) return `Путь к проекту должен быть абсолютным: ${path}`;
  if (!existsSync(path)) return `Каталог проекта не существует: ${path}`;
  try {
    if (!statSync(path).isDirectory()) return `Это не каталог: ${path}`;
  } catch {
    return `Каталог проекта недоступен: ${path}`;
  }
  return null;
}

/**
 * Тело `POST /api/projects` целиком: путь — как у `checkProjectDir`, имя — строка
 * или ничего. Раньше проверялся только путь, и `name: 123` падал 500 на `.trim()`.
 */
export function checkProjectDraft(draft: unknown): string | null {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return 'Тело запроса должно быть объектом с путём к проекту';
  }
  const { path, name } = draft as { path?: unknown; name?: unknown };
  if (typeof path !== 'string') return 'Путь к проекту не задан';
  if (name !== undefined && name !== null && typeof name !== 'string') {
    return 'Имя проекта должно быть строкой';
  }
  return checkProjectDir(path);
}

/** Короткое имя проекта — последний непустой сегмент пути. */
export function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/**
 * Пути к конфигам проекта от пути его каталога. Каталог нормализуется через
 * `resolve`, а все файлы получаются присоединением известных подпутей — выйти
 * за пределы каталога проекта такой путь по построению не может.
 */
export function resolveProjectPaths(projectPath: string): ProjectPaths {
  const root = resolve(projectPath);
  return {
    root,
    claudeMd: join(root, 'CLAUDE.md'),
    settings: join(root, '.claude', 'settings.json'),
    settingsLocal: join(root, '.claude', 'settings.local.json'),
    mcpConfig: join(root, '.mcp.json'),
  };
}

/**
 * Проверка, что путь не выходит за пределы каталога проекта. Пути мы формируем
 * сами (см. `resolveProjectPaths`), но эта функция — страховка на случай, если
 * файл-цель придёт со стороны: запись за пределами проекта недопустима.
 */
export function isInsideProject(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Собрать запись реестра из тела запроса. Путь валидируется вызывающим кодом
 * (`checkProjectDir`) до этого; здесь только нормализация и генерация id.
 */
export function makeProject(draft: ProjectDraft): Project {
  const path = resolve(draft.path.trim());
  return {
    id: randomUUID(),
    name: draft.name?.trim() || projectName(path),
    path,
  };
}

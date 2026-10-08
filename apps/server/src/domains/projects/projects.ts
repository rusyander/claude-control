import { existsSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project, ProjectDraft } from '@agentdeck/contracts';
import { projectInstructionTarget } from '../../lib/instruction-files/instruction-files.ts';
import { spelledOnDisk } from '../../lib/disk-spelling/disk-spelling.ts';
import { normalizeProjectPath } from '../../lib/app-store/projects.ts';

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

/** Чем непригоден каталог проекта — кодом: агенту панели нужен английский текст, человеку русский. */
export type ProjectDirProblem = 'empty' | 'relative' | 'missing' | 'not-dir' | 'unreadable';

export function projectDirProblem(path: string): ProjectDirProblem | null {
  if (!path.trim()) return 'empty';
  if (!isAbsolute(path)) return 'relative';
  if (!existsSync(path)) return 'missing';
  try {
    if (!statSync(path).isDirectory()) return 'not-dir';
  } catch {
    return 'unreadable';
  }
  return null;
}

const PROJECT_DIR_PROBLEM_RU: Record<ProjectDirProblem, (path: string) => string> = {
  empty: () => 'Путь к проекту не задан',
  relative: (path) => `Путь к проекту должен быть абсолютным: ${path}`,
  missing: (path) => `Каталог проекта не существует: ${path}`,
  'not-dir': (path) => `Это не каталог: ${path}`,
  unreadable: (path) => `Каталог проекта недоступен: ${path}`,
};

/** Проблема с каталогом проекта или null, если он пригоден. */
export function checkProjectDir(path: string): string | null {
  const problem = projectDirProblem(path);
  return problem ? PROJECT_DIR_PROBLEM_RU[problem](path) : null;
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
 *
 * Имя файла правил — НЕ константа (П2.7): с 2.1.277 проект без своего
 * `CLAUDE.md` живёт на `AGENTS.md`, и для панели он был невидим. Режим берётся
 * по тому же правилу, что у CLI: ближний файл настроек перекрывает дальний —
 * `.claude/settings.local.json` → `.claude/settings.json` → пользовательский
 * `settings.json`, путь к которому передаёт вызывающий (у него он уже есть).
 */
export function resolveProjectPaths(projectPath: string, userSettingsPath?: string): ProjectPaths {
  const root = resolve(projectPath);
  return {
    root,
    claudeMd: projectInstructionTarget(root, userSettingsPath).filePath,
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
 *
 * Путь — в написании на диске: вставленный путь из %TEMP% или cwd оболочки
 * агента приходит коротким именем 8.3, а раздел «Тесты» ищет проект по
 * написанию на диске — под «как ввели» своя папка e2e выглядела чужой.
 */
/**
 * Проект реестра, стоящий на том же каталоге, — по написанию на диске с ОБЕИХ
 * сторон. Записи, сделанные до перехода на это написание, хранят путь как ввели
 * (короткое имя 8.3), и сверка с сырыми записями их не видела (F-134).
 */
export function findProjectOnDisk(projects: readonly Project[], path: string): Project | undefined {
  const wanted = normalizeProjectPath(spelledOnDisk(resolve(path)));
  return projects.find(
    (project) => normalizeProjectPath(spelledOnDisk(resolve(project.path))) === wanted,
  );
}

export function makeProject(draft: ProjectDraft): Project {
  const path = spelledOnDisk(resolve(draft.path.trim()));
  return {
    id: randomUUID(),
    name: draft.name?.trim() || projectName(path),
    path,
  };
}

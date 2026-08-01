import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  ProjectRunnerInfo,
  ProjectRunnerTarget,
  ProjectWorkspaceSource,
} from '@claude-control/contracts';
import { GLOB_DEPTH, MAX_TARGETS, isWindows } from './project-runner.constants.ts';
import { RunnerError, type RunnerTargetSpec, type TargetMemory } from './project-runner.types.ts';
import { readPackageJson, resolveRunCommand } from './stack.ts';

/* ── Цели запуска: корень и пакеты монорепозитория ───────────────────── */

/** Каталог существует и это каталог. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Содержимое каталога; нет доступа — пустой список, а не исключение. */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Служебные и скрытые каталоги в обходе не участвуют. */
function isSkippedDir(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'build';
}

/** Подкаталоги каталога, годные для обхода: без служебных и не файлы. */
function walkableChildren(root: string, dir: string): string[] {
  const abs = join(root, dir);
  return safeReaddir(abs)
    .filter((name) => !isSkippedDir(name))
    .filter((name) => isDirectory(join(abs, name)))
    .map((name) => (dir ? `${dir}/${name}` : name));
}

/**
 * Развернуть шаблон воркспейса (`apps/*`, `packages/**`) в список подпапок.
 *
 * Полного glob здесь нет намеренно: в шаблонах воркспейсов встречаются ровно
 * `*` и `**`, а тащить зависимость ради двух случаев незачем. `**` разворачивается
 * на ограниченную глубину — иначе обход большой монорепы стоит дороже, чем даёт.
 */
export function expandWorkspacePattern(root: string, pattern: string): string[] {
  const parts = pattern.split('/').filter((part) => part && part !== '.');
  let dirs: string[] = [''];

  for (const part of parts) {
    const next: string[] = [];
    for (const dir of dirs) {
      if (part === '*' || part === '**') {
        const children = walkableChildren(root, dir);
        next.push(...children);
        // `**` — это ещё и «на уровень глубже», и так до предела.
        if (part === '**') {
          let frontier = children;
          for (let depth = 1; depth < GLOB_DEPTH && frontier.length > 0; depth += 1) {
            const deeper: string[] = [];
            for (const child of frontier) deeper.push(...walkableChildren(root, child));
            next.push(...deeper);
            frontier = deeper;
          }
        }
      } else if (isDirectory(join(root, dir, part))) {
        next.push(dir ? `${dir}/${part}` : part);
      }
    }
    dirs = [...new Set(next)];
  }

  return dirs.filter(Boolean);
}

/** Шаблоны воркспейсов проекта и то, откуда они взяты. */
export function workspacePatterns(
  projectDir: string,
): { patterns: string[]; source: ProjectWorkspaceSource } | undefined {
  for (const name of ['pnpm-workspace.yaml', 'pnpm-workspace.yml']) {
    const file = join(projectDir, name);
    if (!existsSync(file)) continue;
    try {
      const doc = parseYaml(readFileSync(file, 'utf8')) as { packages?: unknown };
      const packages = Array.isArray(doc?.packages) ? doc.packages : [];
      const patterns = packages.filter((item): item is string => typeof item === 'string');
      if (patterns.length > 0) return { patterns, source: 'pnpm' };
    } catch {
      // Битый pnpm-workspace.yaml — не повод падать: ниже сработает скан папок.
    }
  }

  const workspaces = readPackageJson(projectDir)?.workspaces;
  const list = Array.isArray(workspaces) ? workspaces : workspaces?.packages;
  if (Array.isArray(list)) {
    const patterns = list.filter((item): item is string => typeof item === 'string');
    if (patterns.length > 0) return { patterns, source: 'npm' };
  }

  // Ни pnpm-workspace, ни workspaces — смотрим в общепринятые места. Это
  // догадка, поэтому источник так и называется, а пользователь видит её в панели.
  const guessed = ['apps', 'packages', 'services'].filter((dir) =>
    isDirectory(join(projectDir, dir)),
  );
  if (guessed.length > 0) return { patterns: guessed.map((dir) => `${dir}/*`), source: 'scan' };

  return undefined;
}

/**
 * Что в этом проекте вообще можно запускать: сам корень (всегда первым — даже
 * без скрипта, чтобы было куда вписать команду вручную) и пакеты монорепозитория
 * со скриптом dev/start.
 */
export function listRunnerTargets(projectDir: string): {
  targets: RunnerTargetSpec[];
  source?: ProjectWorkspaceSource;
  skipped: number;
} {
  const root = resolve(projectDir);
  const rootName = readPackageJson(root)?.name ?? basename(root);
  const targets: RunnerTargetSpec[] = [{ dir: '', path: root, name: rootName }];

  const workspaces = workspacePatterns(root);
  if (!workspaces) return { targets, skipped: 0 };

  const negated = workspaces.patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => pattern.slice(1).replace(/\/+$/, ''));
  const seen = new Set<string>();
  let skipped = 0;

  for (const pattern of workspaces.patterns) {
    if (pattern.startsWith('!')) continue;
    for (const dir of expandWorkspacePattern(root, pattern)) {
      if (seen.has(dir) || negated.includes(dir)) continue;
      seen.add(dir);

      const abs = join(root, dir);
      const pkg = readPackageJson(abs);
      // Пакет без скрипта запуска — библиотека: в списке «что запустить» её нет.
      if (!pkg?.scripts?.dev && !pkg?.scripts?.start) continue;

      if (targets.length >= MAX_TARGETS) {
        skipped += 1;
        continue;
      }
      targets.push({ dir, path: abs, name: pkg.name ?? basename(abs) });
    }
  }

  return { targets, source: workspaces.source, skipped };
}

/**
 * Описание целей запуска для панели: команда, причина отказа и всё, что панель
 * помнит про каждую цель. Одним запросом — поповеру настроек нужен весь список
 * сразу, а не маршрут на цель.
 */
export function describeRunner(
  projectDir: string,
  memoryOf: (targetPath: string) => TargetMemory | undefined = () => undefined,
): ProjectRunnerInfo {
  const root = resolve(projectDir);
  const found = listRunnerTargets(root);

  const targets: ProjectRunnerTarget[] = found.targets.map((target) => {
    const memory = memoryOf(target.path) ?? {};
    const base = {
      dir: target.dir,
      path: target.path,
      name: target.name,
      commandOverride: memory.command,
      pinnedPort: memory.pinnedPort,
      lastPort: memory.port,
      autostart: Boolean(memory.autostart),
    };
    try {
      const spec = resolveRunCommand(target.path, memory.command, root);
      return { ...base, runnable: true, command: spec.display };
    } catch (error) {
      return {
        ...base,
        runnable: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });

  return { projectPath: root, targets, workspaceSource: found.source, skipped: found.skipped };
}

/** Нормализация пути для ключа реестра (Windows нечувствителен к регистру/слэшам). */
export function normalizePath(path: string): string {
  const unified = resolve(path).replace(/\\/g, '/').replace(/\/+$/, '');
  return isWindows ? unified.toLowerCase() : unified;
}

/**
 * Подпапка цели: только относительный путь вниз. Абсолютный путь и `..` —
 * отказ, а не «как-нибудь разберёмся»: каталог запуска обязан лежать внутри
 * проекта, иначе панель запускает что угодно на диске.
 */
export function resolveTargetDir(projectPath: string, dir?: string): { dir: string; path: string } {
  const clean = (dir ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!clean) return { dir: '', path: resolve(projectPath) };
  if (
    clean.split('/').some((part) => part === '..') ||
    /^[a-zA-Z]:/.test(clean) ||
    dir?.[0] === '/'
  )
    throw new RunnerError('bad-path', `Подпапка должна лежать внутри проекта: ${dir ?? ''}`);
  return { dir: clean, path: resolve(projectPath, clean) };
}

/** Каталог проекта существует и это каталог, иначе — текст проблемы. */
export function checkDir(dir: string): string | null {
  if (!dir.trim()) return 'Путь к проекту не задан';
  if (!existsSync(dir)) return `Каталог не существует: ${dir}`;
  if (!isDirectory(dir)) return `Это не каталог: ${dir}`;
  return null;
}

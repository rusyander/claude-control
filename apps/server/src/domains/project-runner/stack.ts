import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  RunnerError,
  type LaunchSpec,
  type PackageJsonShape,
  type PackageManager,
} from './project-runner.types.ts';

/**
 * Чем и как запускается проект: пакетный менеджер, скрипт, итоговая команда.
 * Всё читается с диска и ничего не выполняет — тесты проверяют это на временных
 * каталогах без настоящего dev-сервера.
 */

/** Содержимое package.json каталога; при отсутствии/битом файле — undefined. */
export function readPackageJson(dir: string): PackageJsonShape | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJsonShape;
  } catch {
    return undefined;
  }
}

/**
 * Пакетный менеджер проекта.
 *
 * Сначала поле `packageManager` (`"pnpm@9.1.0"`) — это corepack, то есть прямое
 * указание автора проекта, и оно точнее любой догадки. Дальше lock-файл. В
 * монорепе и то и другое лежит в КОРНЕ, а запускаем мы из подпапки, поэтому от
 * каталога цели поднимаемся вверх до `stopAt` включительно — иначе у любого
 * пакета монорепы получался бы npm независимо от того, чем проект живёт.
 * Ничего не нашли — npm: он есть везде, где есть Node.
 */
export function detectPackageManager(dir: string, stopAt?: string): PackageManager {
  const top = resolve(stopAt ?? dir);
  let current = resolve(dir);
  for (;;) {
    const declared = readPackageJson(current)?.packageManager;
    if (typeof declared === 'string') {
      const name = declared.split('@')[0]?.trim();
      if (name === 'pnpm' || name === 'yarn' || name === 'npm') return name;
    }
    // pnpm-workspace.yaml бывает в git, а lock-файл — далеко не всегда, поэтому
    // он тоже считается признаком: без этого монорепа на pnpm запускалась бы npm.
    if (
      existsSync(join(current, 'pnpm-lock.yaml')) ||
      existsSync(join(current, 'pnpm-workspace.yaml')) ||
      existsSync(join(current, 'pnpm-workspace.yml'))
    ) {
      return 'pnpm';
    }
    if (existsSync(join(current, 'yarn.lock'))) return 'yarn';
    if (existsSync(join(current, 'package-lock.json'))) return 'npm';
    if (current === top) break;
    const up = dirname(current);
    if (up === current) break;
    current = up;
  }
  return 'npm';
}

/** Скрипт запуска: `dev`, иначе `start`, иначе ничего. */
export function detectRunScript(dir: string): 'dev' | 'start' | undefined {
  const scripts = readPackageJson(dir)?.scripts ?? {};
  if (scripts.dev) return 'dev';
  if (scripts.start) return 'start';
  return undefined;
}

/**
 * Разбор строки-оверрайда на слова с учётом кавычек: `node "my server.js" --port`
 * → ['node', 'my server.js', '--port']. Оверрайд задаёт пользователь для своего
 * проекта, поэтому достаточно простого разбора кавычек, без полного шелла.
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

/**
 * Итоговая команда запуска: оверрайд (если задан) в приоритете, иначе
 * `<pm> run <dev|start>`. Нет ни скрипта, ни оверрайда → RunnerError.
 */
export function resolveRunCommand(
  targetDir: string,
  override?: string,
  projectRoot?: string,
): LaunchSpec {
  const trimmed = override?.trim();
  if (trimmed) {
    const [file, ...args] = tokenize(trimmed);
    if (!file) throw new RunnerError('no-script', 'Команда запуска пуста.');
    return { file, args, display: trimmed };
  }

  const script = detectRunScript(targetDir);
  if (!script) {
    throw new RunnerError(
      'no-script',
      'В package.json нет скрипта dev или start. Задайте команду запуска вручную.',
    );
  }
  const pm = detectPackageManager(targetDir, projectRoot);
  return { file: pm, args: ['run', script], display: `${pm} run ${script}` };
}

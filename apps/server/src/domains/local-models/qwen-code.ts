import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import type { QwenCodeInfo } from '@agentdeck/contracts/local-models';
import { localError } from './errors.ts';
import type { JobHandle } from './jobs.ts';
import type { LocalPaths } from './paths.ts';

/**
 * Qwen Code одной кнопкой — в `.local-models/tools/qwen-code`, а не глобально.
 *
 * `npm install -g` пишет в общий каталог пользователя и на части машин требует
 * прав администратора; локальная установка рядом с моделями видна, удаляется
 * вместе с ними и не спорит с версией, которую человек поставил сам. Версия
 * закреплена: проверенная с панелью, а не «последняя на сегодня».
 *
 * Чтобы весь остальной код панели (поиск CLI, чат чужого CLI, перенос среды)
 * нашёл этот `qwen` без особых веток, каталог его запуска дописывается в начало
 * PATH процесса панели — как если бы человек поставил CLI сам.
 */
export const QWEN_CODE_PACKAGE = '@qwen-code/qwen-code';
export const QWEN_CODE_VERSION = '0.25.0';

export function qwenDir(paths: LocalPaths): string {
  return join(paths.tools, 'qwen-code');
}

export function qwenBinDir(paths: LocalPaths): string {
  return join(qwenDir(paths), 'node_modules', '.bin');
}

function binNames(os: NodeJS.Platform): string[] {
  return os === 'win32' ? ['qwen.cmd', 'qwen.exe', 'qwen'] : ['qwen'];
}

export function panelQwenBinary(paths: LocalPaths, os: NodeJS.Platform = process.platform): string {
  return (
    binNames(os)
      .map((name) => join(qwenBinDir(paths), name))
      .find((path) => existsSync(path)) ?? ''
  );
}

export function systemQwenBinary(
  env: NodeJS.ProcessEnv,
  os: NodeJS.Platform = process.platform,
  skipDir = '',
): string {
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    if (skipDir && dir === skipDir) continue;
    for (const name of binNames(os)) {
      const path = join(dir, name);
      if (existsSync(path)) return path;
    }
  }
  return '';
}

export function describeQwenCode(
  paths: LocalPaths,
  env: NodeJS.ProcessEnv = process.env,
): QwenCodeInfo {
  const panel = panelQwenBinary(paths);
  if (panel) {
    let version = '';
    try {
      const manifest = join(qwenDir(paths), 'node_modules', QWEN_CODE_PACKAGE, 'package.json');
      version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version ?? '';
    } catch {
      // Нечитаемый манифест — версия неизвестна, CLI при этом стоит.
    }
    return { binary: panel, version, source: 'panel' };
  }
  const system = systemQwenBinary(env, process.platform, qwenBinDir(paths));
  return system
    ? { binary: system, version: '', source: 'system' }
    : { binary: '', version: '', source: 'none' };
}

/** Каталог запуска своего Qwen Code — в начало PATH процесса панели (один раз). */
export function addQwenToPath(paths: LocalPaths, env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = qwenBinDir(paths);
  if (!existsSync(dir)) return false;
  const key = env.Path !== undefined && env.PATH === undefined ? 'Path' : 'PATH';
  const parts = (env[key] ?? '').split(delimiter);
  if (parts.includes(dir)) return false;
  env[key] = [dir, ...parts.filter(Boolean)].join(delimiter);
  return true;
}

/**
 * Где лежит сам npm. Запуск через `node npm-cli.js`, а не `npm.cmd`: Node на
 * Windows отказывается запускать `.cmd` без оболочки, а оболочка — это
 * кавычки и экранирование на ровном месте.
 */
export function npmCliPath(
  execPath = process.execPath,
  os: NodeJS.Platform = process.platform,
): string {
  const base = dirname(execPath);
  return os === 'win32'
    ? join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(base, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

/** Строки `npm http fetch GET 200 …` — каждый полученный пакет; ими и меряем ход установки. */
export function countFetches(text: string): number {
  return (text.match(/npm http fetch (GET|POST) \d{3}/g) ?? []).length;
}

export async function installQwenCode(
  paths: LocalPaths,
  handle: JobHandle,
  spawnImpl: typeof spawn = spawn,
): Promise<string> {
  const dir = qwenDir(paths);
  mkdirSync(dir, { recursive: true });
  handle.progress({ phase: 'install', doneBytes: 0, totalBytes: 0 });
  const args = [
    npmCliPath(),
    'install',
    '--prefix',
    dir,
    '--no-fund',
    '--no-audit',
    '--loglevel=http',
    `${QWEN_CODE_PACKAGE}@${QWEN_CODE_VERSION}`,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawnImpl(process.execPath, args, { cwd: dir, windowsHide: true });
    let fetched = 0;
    let tail = '';
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString();
      tail = (tail + text).slice(-2000);
      fetched += countFetches(text);
      handle.progress({ doneBytes: fetched });
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    handle.signal.addEventListener('abort', () => child.kill(), { once: true });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else {
        const reason =
          tail
            .trim()
            .split(/\r?\n/)
            .filter((line) => /ERR!/.test(line))
            .slice(-3)
            .join(' ') || `npm exit code ${String(code)}`;
        reject(
          localError('local-npm-failed', `установка Qwen Code не удалась: ${reason}`, { reason }),
        );
      }
    });
  });
  addQwenToPath(paths);
  return panelQwenBinary(paths);
}

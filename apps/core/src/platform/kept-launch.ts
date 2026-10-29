import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { helperEnv, launchDetached } from './detached-launch.ts';
import { resolveExecutable } from './exec-resolve.ts';
import { currentOs, factReason, hasValue, type OsKind } from './os-kind.ts';
import { identityOfPid } from './process-identity.ts';
import type { ProcessIdentity } from './process-table.ts';
import { writeFileAtomic } from './safe-io/atomic-write.ts';
import { readBytesSync } from './safe-io/files.ts';
import { pinEnv } from './spawn.ts';

/**
 * Запуск через хранителя (keeper): служебный процесс ядра, который ПЕРЕЖИВАЕТ ядро (свой
 * сервер моделей, 11 R:PR-04 — перезапущенное ядро возвращается к тому же серверу).
 *
 * Почему не обычный потомок: на Windows libuv кладёт потомков в задание процесса с «убить при
 * закрытии» — смерть ядра уносит сервер. Почему не отвязанный сервер напрямую: отвязанный
 * процесс Windows живёт без консоли, и консольные потомки сервера (раннеры моделей) открыли бы
 * по своему окну. Хранитель — node, отвязанный (своя сессия и группа на POSIX, вне задания ядра на
 * Windows); цель он запускает скрытой (`windowsHide`: своя невидимая консоль, её наследуют
 * раннеры) и обычным потомком — остановка дерева по хранителю снимает и цель.
 *
 * Описание запуска (окружение цели целиком) — файлом 0600 в каталоге состояния, хранитель
 * удаляет его после чтения: окружение не попадает в argv (его видно в списке процессов). Выход
 * цели хранитель пишет файлом — код и сигнал читаются и после смерти ядра.
 */

export const KEEPER_MAIN = fileURLToPath(new URL('./keeper-main.ts', import.meta.url));
export const KEEPER_SPEC_FILE = 'keeper-spec.json';
export const KEEPER_EXIT_FILE = 'keeper-exit.json';

export interface KeptSpec {
  command: string;
  args: readonly string[];
  /** cwd цели. */
  cwd: string;
  /** Окружение цели целиком (ничего не наследуется). */
  env: Record<string, string>;
  extraDirs?: readonly string[];
  /** Каталог состояния: файл описания и файл выхода. */
  stateDir: string;
  /** Метка дерева и для самого хранителя (поиск переродителей, 09). */
  marker?: { name: string; value: string };
  os?: OsKind;
}

/** Что хранитель пишет в `KEEPER_SPEC_FILE`. */
export interface KeeperSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  extraDirs?: string[];
  exitPath: string;
}

/** Что хранитель пишет в `KEEPER_EXIT_FILE`. */
export type KeptExit = { code: number | null; signal: string | null } | { refused: string };

export type KeptLaunch =
  { ok: true; identity: ProcessIdentity } | { ok: false; reason: string; pid?: number };

export async function launchKept(spec: KeptSpec): Promise<KeptLaunch> {
  const os = spec.os ?? currentOs();
  // Отказ «не найден» — до запуска хранителя, тем же текстом, что у spawnResolved.
  const resolution = resolveExecutable(spec.command, {
    env: pinEnv(spec.env, os),
    os,
    // Хранитель разрешает от cwd цели (`spawnResolved`): проверка до него — от того же каталога.
    cwd: spec.cwd,
    ...(spec.extraDirs ? { extraDirs: spec.extraDirs } : {}),
  });
  if (!resolution.ok)
    return {
      ok: false,
      reason: resolution.absent
        ? `«${spec.command}» not found (searched ${resolution.searched.length} dirs)`
        : `«${resolution.found}» refused: ${resolution.refused}`,
    };
  const specPath = join(spec.stateDir, KEEPER_SPEC_FILE);
  const keeperSpec: KeeperSpec = {
    command: spec.command,
    args: [...spec.args],
    cwd: spec.cwd,
    env: spec.env,
    ...(spec.extraDirs ? { extraDirs: [...spec.extraDirs] } : {}),
    exitPath: join(spec.stateDir, KEEPER_EXIT_FILE),
  };
  writeFileAtomic(specPath, JSON.stringify(keeperSpec), { mode: 0o600 });
  const started = await launchDetached({
    file: process.execPath,
    args: ['--experimental-strip-types', '--no-warnings', KEEPER_MAIN, specPath],
    cwd: spec.stateDir,
    env: { ...helperEnv(), ...(spec.marker ? { [spec.marker.name]: spec.marker.value } : {}) },
    os,
  });
  if (!started.ok) return { ok: false, reason: `keeper did not start: ${started.reason}` };
  const identity = await identityOfPid(started.pid);
  if (hasValue(identity)) return { ok: true, identity: identity.value };
  return {
    ok: false,
    pid: started.pid,
    reason:
      'absent' in identity
        ? (describeKeptExit(readKeptExit(spec.stateDir)) ??
          'keeper gone before its identity was read')
        : `keeper identity unread: ${factReason(identity)}`,
  };
}

export function readKeptExit(stateDir: string): KeptExit | undefined {
  const bytes = readBytesSync(join(stateDir, KEEPER_EXIT_FILE));
  if (!hasValue(bytes)) return undefined;
  try {
    return JSON.parse(bytes.value.toString('utf8')) as KeptExit;
  } catch {
    return undefined;
  }
}

export function describeKeptExit(exit: KeptExit | undefined): string | undefined {
  if (!exit) return undefined;
  if ('refused' in exit) return `refused: ${exit.refused}`;
  return `exited early (code ${exit.code ?? '-'}, signal ${exit.signal ?? '-'})`;
}

/** Номер занят (EPERM — процесс есть, но чужой по правам). Дешёвая проверка в циклах ожидания. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { currentOs, type Fact, type OsKind } from './os-kind.ts';
import { longForm, MAX_PATH } from './paths.ts';
import { identityOfPid } from './process-identity.ts';
import type { ProcessIdentity, ProcessTableSource } from './process-table.ts';
import { resolveExecutable, type Resolution } from './exec-resolve.ts';

/**
 * Единственный запуск процесса в ядре (03 §Launcher, P25, P54) — для любого CLI и любого
 * инструмента; ничего от конкретного CLI здесь нет.
 * - без оболочки, никогда (`shell: false`): `.cmd`/`.ps1` разобраны до настоящей цели,
 *   нераспознанная обёртка — отказ с причиной;
 * - окружение ЗАКРЕПЛЕНО: передаётся целиком тем, кто запускает (пин задачи + сессия +
 *   ядро), из окружения ядра не наследуется ничего — иначе ключи и переменные панели
 *   утекали бы в сессию, а пин задачи значил бы «плюс случайное»;
 * - cwd — длинная форма с диска (8.3 раскрыт: F13, CLI спрашивал права на свой cwd);
 * - длинный текст (промпт, бриф) — файлом (`writeTextArg`), не argv.
 */

export interface SpawnSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  /** Полное окружение процесса; ничего не наследуется. */
  env: Record<string, string>;
  stdio?: StdioOptions;
  detached?: boolean;
  /**
   * Сделать процесс лидером своей группы там, где группы есть (POSIX): остановка дерева
   * шлёт сигнал группе целиком. На Windows не отвязывает — без консоли каждый потомок
   * CLI открыл бы своё окно.
   */
  ownGroup?: boolean;
  /** Каталоги поиска после PATH окружения (данные переходника CLI). */
  extraDirs?: readonly string[];
  os?: OsKind;
}

export type SpawnOutcome =
  | { ok: true; child: ChildProcess; resolution: Extract<Resolution, { ok: true }>; cwd: string }
  | { ok: false; reason: string; resolution?: Resolution };

/**
 * Окружение для spawn: на Windows имена переменных без учёта регистра — `Path` и `PATH`
 * вместе дали бы процессу два PATH, и какой из них победит, решал бы порядок ключей.
 * Последнее написание выигрывает.
 */
export function pinEnv(
  env: Record<string, string>,
  os: OsKind = currentOs(),
): Record<string, string> {
  if (os !== 'win32') return { ...env };
  const byLower = new Map<string, [string, string]>();
  for (const [key, value] of Object.entries(env)) byLower.set(key.toLowerCase(), [key, value]);
  return Object.fromEntries(byLower.values());
}

/**
 * Значение для `NODE_OPTIONS` в кавычках. Node разбирает переменную сам: внутри двойных
 * кавычек `\` экранирует следующий знак, поэтому путь Windows `C:\a b\x.cjs` без удвоения
 * превратился бы в `C:a bx.cjs`, а без кавычек — разорвался бы на пробеле (03: «NODE_OPTIONS
 * values quoted — paths with spaces»).
 */
export function quoteNodeOption(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Один аргумент командной строки Windows по правилам `CommandLineToArgvW` — для мест, где
 * строку собирает не libuv (действие задачи планировщика, `Win32_Process.Create`).
 */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      slashes += 1;
      continue;
    }
    if (char === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(slashes) + char;
    }
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

/** Длинный текст — файлом (P25: «prompt via file»); путь уходит в argv вместо текста. */
export function writeTextArg(dir: string, name: string, text: string): string {
  mkdirSync(dir, { recursive: true });
  const file = longForm(`${dir}/${name}`);
  writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  return file;
}

export function spawnResolved(spec: SpawnSpec): SpawnOutcome {
  const os = spec.os ?? currentOs();
  const env = pinEnv(spec.env, os);
  // Явный относительный путь (`./gradlew`) — от cwd запуска, не от каталога ядра (B1r3-F02).
  const resolution = resolveExecutable(spec.command, {
    env,
    os,
    cwd: spec.cwd,
    ...(spec.extraDirs ? { extraDirs: spec.extraDirs } : {}),
  });
  if (!resolution.ok) {
    const reason = resolution.absent
      ? `«${spec.command}» not found (searched ${resolution.searched.length} dirs)`
      : `«${resolution.found}» refused: ${resolution.refused}`;
    return { ok: false, reason, resolution };
  }
  const cwd = longForm(spec.cwd, os);
  if (!existsSync(cwd)) return { ok: false, reason: `cwd does not exist: ${cwd}`, resolution };
  // CreateProcess не принимает cwd длиннее MAX_PATH даже с `\\?\` — называем, а не падаем.
  // Текущий каталог Win32 — до MAX_PATH − 2 знаков вместе с завершающим `\`.
  if (os === 'win32' && cwd.length >= MAX_PATH - 2) {
    return { ok: false, reason: `cwd longer than Win32 allows (${cwd.length} chars)`, resolution };
  }
  try {
    const child = spawn(resolution.file, [...resolution.prefix, ...spec.args], {
      cwd,
      env: { ...env, ...resolution.envAdd },
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: false,
      stdio: spec.stdio ?? 'pipe',
      detached: (spec.detached ?? false) || (spec.ownGroup === true && os !== 'win32'),
    });
    return { ok: true, child, resolution, cwd };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      resolution,
    };
  }
}

/**
 * Запуск + личность процесса (номер + время старта) — то, что ядро пишет в журнал
 * (03: «Returns the real pid + start time»). Личность не прочиталась — `unknown`, запуск
 * не отменяется: процесс уже идёт, решение о нём — у вызывающего.
 */
export async function spawnTracked(
  spec: SpawnSpec,
  source?: ProcessTableSource,
): Promise<SpawnOutcome & { identity?: Fact<ProcessIdentity> }> {
  const outcome = spawnResolved(spec);
  if (!outcome.ok) return outcome;
  const pid = outcome.child.pid;
  if (pid === undefined) return { ...outcome, identity: { unknown: 'spawn returned no pid' } };
  return { ...outcome, identity: await identityOfPid(pid, source) };
}

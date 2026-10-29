import path from 'node:path';
import { currentOs, envValue, homeDir, type OsKind } from './os-kind.ts';
import { resolveExecutable, type Resolution } from './exec-resolve.ts';

/**
 * Где искать исполняемый файл CLI (09 §CLI location) — обобщённо, для любого провайдера:
 * имя исполняемого файла и свои каталоги приносит переходник CLI, платформа знает только
 * общие места пользовательских установок на каждой ОС. Строка таблицы 09 для CLI по
 * умолчанию (`~/.local/bin`, глобальный npm, `/opt/homebrew/bin`, `/usr/local/bin`) — это
 * ровно `userBinDirs` плюс данные его переходника, а не ветка платформы.
 *
 * Перенос логики `apps/server/src/providers/cli` (кандидаты `<имя>.cmd` → голое имя) как
 * данных: порядок «.exe раньше обёртки» теперь в `exec-resolve.ts` по каталогам PATH.
 */

/** Каталог глобальных пакетов npm: `npm_config_prefix`, иначе место по умолчанию ОС. */
export function npmGlobalBinDir(
  env: NodeJS.ProcessEnv = process.env,
  os: OsKind = currentOs(),
): string {
  const prefix = envValue(env, 'npm_config_prefix', os);
  if (os === 'win32') {
    const appData =
      envValue(env, 'APPDATA', os) ?? path.win32.join(homeDir(env, os), 'AppData', 'Roaming');
    return prefix ?? path.win32.join(appData, 'npm');
  }
  return prefix
    ? path.posix.join(prefix, 'bin')
    : path.posix.join(homeDir(env, os), '.npm-global', 'bin');
}

/**
 * Общие каталоги пользовательских установок ОС (порядок = предпочтение): то, что
 * установщики CLI кладут мимо PATH процесса, запущенного GUI, launchd или планировщиком.
 */
export function userBinDirs(
  env: NodeJS.ProcessEnv = process.env,
  os: OsKind = currentOs(),
): string[] {
  const home = homeDir(env, os);
  if (os === 'win32') return [path.win32.join(home, '.local', 'bin'), npmGlobalBinDir(env, os)];
  const dirs = [path.posix.join(home, '.local', 'bin'), npmGlobalBinDir(env, os)];
  if (os === 'darwin') dirs.push('/opt/homebrew/bin');
  dirs.push('/usr/local/bin', '/usr/bin');
  return dirs;
}

export interface CliLocateSpec {
  /** Имя исполняемого файла без расширения — его приносит переходник CLI. */
  executable: string;
  /** Свои каталоги переходника, ищутся после PATH и раньше общих. */
  dirs?: readonly string[];
  /** Явный путь от пользователя — выигрывает у поиска. */
  override?: string;
  env?: NodeJS.ProcessEnv;
  os?: OsKind;
  /** Добавлять ли `userBinDirs` (по умолчанию да). */
  commonDirs?: boolean;
}

export type CliLocation = Resolution & { via: 'override' | 'search' };

export function locateCli(spec: CliLocateSpec): CliLocation {
  const os = spec.os ?? currentOs();
  const env = spec.env ?? process.env;
  if (spec.override) return { ...resolveExecutable(spec.override, { env, os }), via: 'override' };
  const extraDirs = [
    ...(spec.dirs ?? []),
    ...(spec.commonDirs === false ? [] : userBinDirs(env, os)),
  ];
  return { ...resolveExecutable(spec.executable, { env, os, extraDirs }), via: 'search' };
}

import { join } from 'node:path';
import { currentOs, envValue, homeDir, type OsKind } from './os-kind.ts';

/**
 * Каталоги данных и конфигурации пользователя по окружению (P51: переменные дома читаются только
 * в `platform/`). Переходники CLI берут отсюда свои места (`Block/goose`, `opencode`), а не
 * читают `APPDATA` / `XDG_*` сами. Окружение — пин задачи, не процесс ядра.
 */

/** Windows `%APPDATA%` (Roaming); нет переменной — `<дом>\AppData\Roaming`. */
export function roamingAppDataDir(env: NodeJS.ProcessEnv, os: OsKind = currentOs()): string {
  return envValue(env, 'APPDATA', os) || join(homeDir(env, os), 'AppData', 'Roaming');
}

/** POSIX `$XDG_DATA_HOME`; нет — `~/.local/share`. */
export function xdgDataHome(env: NodeJS.ProcessEnv, os: OsKind = currentOs()): string {
  return envValue(env, 'XDG_DATA_HOME', os) || join(homeDir(env, os), '.local', 'share');
}

/** POSIX `$XDG_CONFIG_HOME`; нет — `~/.config`. */
export function xdgConfigHome(env: NodeJS.ProcessEnv, os: OsKind = currentOs()): string {
  return envValue(env, 'XDG_CONFIG_HOME', os) || join(homeDir(env, os), '.config');
}

/** Пути этой ОС сравниваются без учёта регистра (Windows). */
export const pathsFoldCase = (os: OsKind = currentOs()): boolean => os === 'win32';

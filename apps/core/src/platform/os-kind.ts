import { homedir } from 'node:os';

/**
 * Три системы ядра (09). Всё, что зависит от ОС, принимает `os` параметром со значением
 * по умолчанию `currentOs()`: так модуль Linux или macOS проверяется на Windows по
 * записанному выводу, а не только там, где он исполняется.
 */
export type OsKind = 'win32' | 'linux' | 'darwin';

/**
 * Прочие POSIX (freebsd и т. п.) идут как linux: ядро их не обещает (09 — три системы),
 * но и падать на старте незачем — то, чего на них нет, вернётся `unknown`.
 */
export function currentOs(): OsKind {
  const name = process.platform;
  if (name === 'win32' || name === 'darwin') return name;
  return 'linux';
}

/** Ответ внешнего чтения в форме 01 §Facts: значение, «нет» или «неизвестно» с причиной. */
export type Fact<T> = { value: T } | { absent: true; detail?: string } | { unknown: string };

/** Забота, которой на этой ОС нет вовсе (exec-бит на Windows, PATH оболочки входа). */
export interface NotApplicable {
  notApplicable: string;
}

export function hasValue<T>(fact: Fact<T>): fact is { value: T } {
  return 'value' in fact;
}

/**
 * Домашний каталог пользователя. Переменные читаются здесь, а не по ядру (P51): на Windows
 * `USERPROFILE`, на POSIX `HOME`; нет переменной — то, что знает Node.
 */
export function homeDir(env: NodeJS.ProcessEnv = process.env, os: OsKind = currentOs()): string {
  const fromEnv = os === 'win32' ? env.USERPROFILE : env.HOME;
  return fromEnv && fromEnv.length > 0 ? fromEnv : homedir();
}

/**
 * Имена переменных, значащих домашний каталог, на всех трёх системах (P51): разбор команд
 * (`$HOME`, `%USERPROFILE%`, `$env:USERPROFILE`) узнаёт дом по этому списку, а не по своему.
 */
export const HOME_ENV_NAMES: readonly string[] = ['HOME', 'USERPROFILE'];

/** Личный каталог времени выполнения POSIX (`XDG_RUNTIME_DIR`); пусто или нет — `undefined`. */
export function userRuntimeDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.XDG_RUNTIME_DIR || undefined;
}

/** Значение переменной окружения без учёта регистра имени (Windows хранит `Path`, `PATH`, `path`). */
export function envValue(
  env: NodeJS.ProcessEnv,
  name: string,
  os: OsKind = currentOs(),
): string | undefined {
  if (os !== 'win32') return env[name];
  const lower = name.toLowerCase();
  const key = Object.keys(env).find((item) => item.toLowerCase() === lower);
  return key === undefined ? undefined : env[key];
}

/** Разделитель списка путей в PATH. */
export function pathListSeparator(os: OsKind = currentOs()): string {
  return os === 'win32' ? ';' : ':';
}

/** Каталоги PATH окружения, пустые выброшены. */
export function pathDirs(env: NodeJS.ProcessEnv, os: OsKind = currentOs()): string[] {
  return (envValue(env, 'PATH', os) ?? '').split(pathListSeparator(os)).filter(Boolean);
}

/** Почему значения нет — для текста остатка и `unknown` наверх. */
export function factReason<T>(fact: Fact<T>): string {
  if ('unknown' in fact) return fact.unknown;
  if ('absent' in fact) return `absent${fact.detail ? `: ${fact.detail}` : ''}`;
  return 'value';
}

/** Сообщение исключения без `instanceof`-ветвлений по месту вызова. */
export function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

/** Пауза для опросов платформы (ожидание выхода процесса, появления файла). */
export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

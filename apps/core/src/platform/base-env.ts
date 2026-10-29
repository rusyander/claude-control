import type { OsKind } from './os-kind.ts';
import { readLoginShellPath } from './shell-path.ts';

/**
 * Базовое окружение дочерних инструментов (P51: имена переменных ОС знает только platform/).
 * Ядро не передаёт своё окружение целиком: только то, без чего раннеры и установщики не стартуют
 * на Windows и POSIX, плюс PATH логин-шелла пользователя — тот, с которым он сам запускает команды.
 */
const OS_BASE_NAMES = [
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'ComSpec',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'LC_ALL',
  'USER',
  'USERNAME',
  'SHELL',
] as const;

/**
 * Системные временные папки (Windows `TEMP`/`TMP`, POSIX `TMPDIR`): раннер проверок ставит свою
 * на каждый прогон (P40), установщику нужна общая.
 */
const TEMP_NAMES = ['TEMP', 'TMP', 'TMPDIR'] as const;

/**
 * Где движок контейнеров (A2r5-F07): без них testcontainers и CLI в прогоне на Colima / Podman /
 * rootless не находят сокет — красный по коду вместо `no-verdict(env)`. Плюс `TESTCONTAINERS_*`.
 */
const ENGINE_NAMES = [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'XDG_RUNTIME_DIR',
] as const;
const ENGINE_PREFIX = 'TESTCONTAINERS_';

export interface BaseEnvOptions {
  /** Передать системные временные папки. */
  temp: boolean;
  /** Окружение-источник (имена И PATH); по умолчанию — окружение ядра. */
  env?: NodeJS.ProcessEnv;
  /** Окружение движка, с которым проба реально поговорила (`EngineHandle.env`), — поверх своих. */
  engine?: Readonly<Record<string, string | undefined>>;
  /** ОС для чтения PATH (по умолчанию текущая) — подмена для тестов. */
  os?: OsKind;
}

export async function readBaseEnv(options: BaseEnvOptions): Promise<Record<string, string>> {
  const source = options.env ?? process.env;
  const names: readonly string[] = [
    ...OS_BASE_NAMES,
    ...ENGINE_NAMES,
    ...(options.temp ? TEMP_NAMES : []),
    ...Object.keys(source).filter((n) => n.startsWith(ENGINE_PREFIX)),
  ];
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  for (const name of ENGINE_NAMES) {
    const value = options.engine?.[name];
    if (value !== undefined) env[name] = value;
  }
  // PATH — из того же источника, что и имена (B2r6-F05): иначе переданное окружение задачи
  // получило бы PATH ядра.
  env.PATH = (
    await readLoginShellPath({ env: source, ...(options.os ? { os: options.os } : {}) })
  ).path;
  return env;
}

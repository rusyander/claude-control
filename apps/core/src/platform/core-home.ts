import { mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { currentOs, homeDir, type OsKind } from './os-kind.ts';

/**
 * Дом ядра (00 §Core home): `~/.agentdeck/core/` (Windows — `%USERPROFILE%\.agentdeck\core`),
 * `AGENTDECK_CORE_HOME` переопределяет на всех системах. Вне любого каталога конфигурации CLI.
 * Каждый интеграционный тест работает на одноразовом доме (песочница vitest задаёт переменную).
 *
 * Путь приводится к длинной настоящей форме (`realpath.native`): короткое имя 8.3
 * (`RUSYAN~1`), регистр диска и разделители иначе дали бы два написания одного дома — два
 * журнала одной задачи (P78, F13).
 */

export const CORE_HOME_ENV = 'AGENTDECK_CORE_HOME';

export interface CoreHomeLayout {
  root: string;
  token: string;
  config: string;
  tasks: string;
  profiles: string;
  scenarios: string;
  builds: string;
  procs: string;
  queue: string;
  spool: string;
  logs: string;
  backups: string;
}

export function layoutOf(root: string): CoreHomeLayout {
  return {
    root,
    token: join(root, 'token'),
    config: join(root, 'config.json'),
    tasks: join(root, 'tasks'),
    profiles: join(root, 'profiles'),
    scenarios: join(root, 'scenarios'),
    builds: join(root, 'builds'),
    procs: join(root, 'procs.json'),
    queue: join(root, 'queue'),
    spool: join(root, 'spool'),
    logs: join(root, 'logs'),
    backups: join(root, 'backups'),
  };
}

export function defaultCoreHome(
  env: NodeJS.ProcessEnv = process.env,
  os: OsKind = currentOs(),
): string {
  const override = env[CORE_HOME_ENV];
  if (override && override.trim() !== '') return resolve(override);
  return join(homeDir(env, os), '.agentdeck', 'core');
}

/** Создать каталоги дома и вернуть раскладку по длинной настоящей форме пути. */
export function ensureCoreHome(root: string = defaultCoreHome()): CoreHomeLayout {
  mkdirSync(root, { recursive: true });
  const real = realpathSync.native(root);
  const layout = layoutOf(real);
  for (const dir of [
    layout.tasks,
    layout.profiles,
    layout.scenarios,
    layout.builds,
    layout.queue,
    layout.spool,
    layout.logs,
    layout.backups,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  return layout;
}

export function taskDir(layout: CoreHomeLayout, taskId: string): string {
  return join(layout.tasks, taskId);
}

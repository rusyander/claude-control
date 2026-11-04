import { mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
  /** Замок одного ядра на дом: второе ядро рядом с живым — отказ (`bootstrap/boot/home-lock.ts`). */
  lock: string;
  queue: string;
  spool: string;
  logs: string;
  backups: string;
  /**
   * Копии вложений чата (s10 G11): `<родитель дома>/agentdeck-attachments/<имя дома>/<taskId>/` — ВНЕ
   * дома ядра, рядом с ним (`attachmentsHome`).
   * Оверлей CLI каждого сеанса запрещает `Read(<дом>/**)`, а запрет CLI старше любого разрешения:
   * копия внутри дома не читалась бы никогда. Судья открывает сеансу только каталог своей задачи.
   */
  attachments: string;
}

/**
 * Имена корня копий по порядку предпочтения. Запрет CLI на дом с длинным именем терпим к 8.3:
 * сегмент дома `core-home` становится `*c*o*r*e*-*h*` и ловит любого соседа с этими буквами по
 * порядку — `core-home-attachments` и `core-attachments` в том числе (живой отказ «File is in a
 * directory that is denied»). Поэтому имя соседа не выводится из имени дома, а выбирается первое,
 * которое шаблон этого дома не ловит.
 */
const ATTACHMENT_ROOT_NAMES = ['agentdeck-attachments', 'attachments', 'att'] as const;
const DOS_NAME = /^[A-Za-z0-9_\-$~#%&@^'`]{1,8}(\.[A-Za-z0-9_\-$~#%&@^'`]{1,3})?$/;
const DOS_CHAR = /[A-Za-z0-9_\-$~#%&@^'`]/;
const escapeRe = (c: string): string => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Ловит ли запрет CLI на сегмент дома `home` соседа `name` — те же формы, что
 * `adapters/claude/path-pattern.ts`: точная любого регистра, терпимая к `~N` (до шести знаков
 * основы по порядку) и хэш-форма (два знака, четыре любых, `~`).
 */
export function homeDenyCatches(home: string, name: string): boolean {
  if (home.toLowerCase() === name.toLowerCase()) return true;
  if (DOS_NAME.test(home)) return false;
  const bare = home.replace(/^[. ]+/, '');
  const dot = bare.lastIndexOf('.');
  const stem = [...(dot > 0 ? bare.slice(0, dot) : bare).replace(/[. ]/g, '')];
  const at = (c: string): string => (DOS_CHAR.test(c) ? escapeRe(c) : '.');
  if (stem.length === 0) return true;
  const tolerant = new RegExp(`${stem.slice(0, 6).map(at).join('.*')}`, 'i');
  const hash = new RegExp(
    `^${stem.slice(0, 2).map(at).join('')}${stem.length < 2 ? '.*' : '.{4}'}~`,
    'i',
  );
  return tolerant.test(name) || hash.test(name);
}

/**
 * Корень копий вложений для дома `root`: `<родитель>/<сосед>/<имя дома>` — сосед дома, не внутри,
 * с именем, которое запрет на дом не ловит; имя дома внутри разводит два дома одного родителя.
 * Ни одно имя не подошло (дом из одних не-8.3 знаков) — первое: вложение не прочтётся, но запрет
 * не ослаблен.
 */
export function attachmentsHome(root: string): string {
  const home = basename(root);
  const name =
    ATTACHMENT_ROOT_NAMES.find((n) => !homeDenyCatches(home, n)) ?? ATTACHMENT_ROOT_NAMES[0];
  return join(dirname(root), name, home);
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
    lock: join(root, 'core.lock'),
    queue: join(root, 'queue'),
    spool: join(root, 'spool'),
    logs: join(root, 'logs'),
    backups: join(root, 'backups'),
    attachments: attachmentsHome(root),
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

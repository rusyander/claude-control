import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LedgerInstall, LedgerSummary, LedgerEvent } from './verify-ledger.types.ts';

/**
 * Журнал проверок со стороны панели (стадия 0, `.agent/tmp/verify-ledger-design.agent.md`
 * §2 «Enforcement»): копия preload в данных панели, самопроверка и окружение,
 * которое панель отдаёт всем, кого запускает, — Claude, чужим CLI, локальным и
 * контурным прогонам.
 *
 * Копия, а не путь в репозитории: `--require` на несуществующий файл роняет
 * КАЖДЫЙ процесс node, включая сам CLI (проверено 19.10), а смена ветки
 * панели удалила бы файл из-под живых сессий. Каталог версии — по отпечатку
 * содержимого, старые версии не удаляются: их ещё держат запущенные сессии.
 */

const FILES = ['checks.cjs', 'delta.cjs', 'ledger.cjs', 'preload.cjs', 'vcs-delta.mjs'] as const;
const LEDGER_ENV = 'AGENTDECK_VERIFY_LEDGER';

/**
 * Постоянный вход `bin/preload.cjs`: на него указывает и окружение панели, и
 * `env.NODE_OPTIONS` в настройках CLI (VS Code, терминал — без панели). Файл
 * никогда не удаляется и грузит версию из `bin/current`; любой сбой — тишина,
 * иначе `--require` уронил бы каждый процесс node, включая хуки.
 */
const STABLE_SHIM = `'use strict';
// Stable entry of the verify ledger (written by the agentdeck panel). Version lives in ./current.
try {
  const fs = require('node:fs');
  const path = require('node:path');
  const v = fs.readFileSync(path.join(__dirname, 'current'), 'utf8').trim();
  if (/^[0-9a-f]{12}$/.test(v)) require(path.join(__dirname, v, 'preload.cjs'));
} catch {
  /* no version, no ledger: the check runs as is */
}
`;

/**
 * Вход с замком `bin/preload-locked.cjs`: панель ставит его группам разделения. Замок и
 * дом журнала живут в самом входе (глобальный символ до загрузки preload), поэтому ни
 * `AGENTDECK_VERIFY_LEDGER=off`, ни снятый `_LOCK`, ни чужой `_HOME`, ни `_DELTA=off`
 * журнал не выключают — это переменные окружения, а вход задан путём.
 */
const LOCKED_SHIM = `'use strict';
// Locked entry of the verify ledger (written by the agentdeck panel for split groups).
try {
  const path = require('node:path');
  globalThis[Symbol.for('agentdeck.verify-ledger.locked')] = { home: path.dirname(__dirname) };
  require(path.join(__dirname, 'preload.cjs'));
} catch {
  /* no ledger: the check runs as is */
}
`;

export function ledgerHome(appData: string): string {
  return join(appData, 'verify-ledger');
}

/** Запись через переименование: процесс, читающий вход прямо сейчас, не увидит половину файла. */
function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

/** Путь для NODE_OPTIONS: обратный слеш там — экранирование (проверено 19.10), значит только `/`. */
const forNodeOptions = (path: string) => path.replace(/\\/g, '/');

/** `AGENTDECK_VERIFY_LEDGER_SOURCE=tree` — поставить рабочее дерево, даже недописанное. */
const SOURCE_ENV = 'AGENTDECK_VERIFY_LEDGER_SOURCE';

interface LedgerSources {
  names: string[];
  bodies: Buffer[];
  source: 'tree' | 'head';
}

/**
 * Что ставить. `committedOnly` (загрузка панели): рабочее дерево — только когда каталог журнала в
 * git чист; иначе версия из HEAD. 24.10 сохранение агента посреди правки журнала перезапускало
 * dev-сервер, и он ставил живым группам недописанный журнал (версии 275ba0ca, f15abf50). Не git
 * (поставлено пакетом) — дерево как есть. Тесты зовут без флага: проверяют то, что в дереве.
 */
function ledgerSources(
  sourceDir: string,
  committedOnly: boolean,
  env: NodeJS.ProcessEnv,
): LedgerSources {
  const tree = (): LedgerSources => ({
    names: [...FILES],
    bodies: FILES.map((name) => readFileSync(join(sourceDir, name))),
    source: 'tree',
  });
  if (!committedOnly || String(env[SOURCE_ENV] ?? '').toLowerCase() === 'tree') return tree();
  const git = (args: string[]) =>
    spawnSync('git', ['-C', sourceDir, ...args], { timeout: 10_000, windowsHide: true });
  const status = git(['status', '--porcelain', '--untracked-files=all', '--', '.']);
  if (status.status !== 0 || String(status.stdout).trim() === '') return tree();
  const names: string[] = [];
  const bodies: Buffer[] = [];
  // Файл, которого в HEAD ещё нет, — часть недописанной версии: версия HEAD обходится без него.
  for (const name of FILES) {
    const shown = git(['show', `HEAD:./${name}`]);
    if (shown.status !== 0) continue;
    names.push(name);
    bodies.push(shown.stdout);
  }
  if (!names.includes('preload.cjs')) throw new Error('no committed preload.cjs in HEAD');
  return { names, bodies, source: 'head' };
}

/**
 * Проба версии: preload через NODE_OPTIONS и КАЖДЫЙ модуль версии. preload грузит delta.cjs и
 * прочие лениво, поэтому голый `node -e` пропускал синтаксическую ошибку в них (24.10).
 */
function probeScript(dir: string, names: string[]): string {
  const cjs = names.filter((name) => name.endsWith('.cjs')).map((name) => join(dir, name));
  const esm = names
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => pathToFileURL(join(dir, name)).href);
  return (
    `for (const file of ${JSON.stringify(cjs)}) require(file);` +
    `Promise.all(${JSON.stringify(esm)}.map((url) => import(url)))` +
    `.then(() => process.stdout.write("ok"), () => process.exit(4));`
  );
}

/**
 * Ставит версию preload и проверяет её живым node (`probeScript`). Не прошла — `preload: null`
 * и причина: панель тогда ничего не подмешивает, проверки идут как раньше.
 */
export function installLedger(opts: {
  appData: string;
  sourceDir: string;
  nodePath?: string;
  env?: NodeJS.ProcessEnv;
  /** Загрузка панели: недописанное рабочее дерево журнала не ставится (`ledgerSources`). */
  committedOnly?: boolean;
}): LedgerInstall {
  const env = opts.env ?? process.env;
  if (String(env[LEDGER_ENV] ?? '').toLowerCase() === 'disabled') {
    return { preload: null, reason: 'disabled' };
  }
  try {
    const { names, bodies, source } = ledgerSources(
      opts.sourceDir,
      opts.committedOnly ?? false,
      env,
    );
    const hash = createHash('sha256');
    for (const body of bodies) hash.update(body);
    const version = hash.digest('hex').slice(0, 12);
    const dir = join(ledgerHome(opts.appData), 'bin', version);
    if (!names.every((name) => existsSync(join(dir, name)))) {
      const tmp = `${dir}.${process.pid}.tmp`;
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });
      names.forEach((name, i) => writeFileSync(join(tmp, name), bodies[i]!));
      rmSync(dir, { recursive: true, force: true });
      renameSync(tmp, dir);
    }
    const preload = forNodeOptions(join(dir, 'preload.cjs'));
    const probe = spawnSync(opts.nodePath ?? process.execPath, ['-e', probeScript(dir, names)], {
      env: { ...env, NODE_OPTIONS: withPreload(env.NODE_OPTIONS, preload) },
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    if (probe.status !== 0 || probe.stdout !== 'ok') {
      return { preload: null, reason: `self-test failed (${probe.status ?? probe.signal})` };
    }
    // Версия прошла самопроверку — только теперь постоянный вход переключается на неё.
    const bin = join(ledgerHome(opts.appData), 'bin');
    writeAtomic(join(bin, 'current'), version);
    const shim = join(bin, 'preload.cjs');
    if (!existsSync(shim) || readFileSync(shim, 'utf8') !== STABLE_SHIM)
      writeAtomic(shim, STABLE_SHIM);
    const lockedShim = join(bin, 'preload-locked.cjs');
    if (!existsSync(lockedShim) || readFileSync(lockedShim, 'utf8') !== LOCKED_SHIM)
      writeAtomic(lockedShim, LOCKED_SHIM);
    return {
      preload: forNodeOptions(shim),
      lockedPreload: forNodeOptions(lockedShim),
      version,
      source,
    };
  } catch (error) {
    return { preload: null, reason: `install failed: ${(error as Error).message}` };
  }
}

/**
 * NODE_OPTIONS с нашим `--require`: прежние ключи остаются (`--max-old-space-size`
 * человека не теряется), чужая версия журнала — заменяется, а не копится.
 */
export function withPreload(existing: string | undefined, preload: string): string {
  const rest = String(existing ?? '')
    .replace(/--require[= ]("[^"]*verify-ledger[^"]*"|\S*verify-ledger\S*)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${rest ? `${rest} ` : ''}--require "${preload}"`;
}

/**
 * Окружение для всех запусков панели. Метку CLI ставит тот, кто запускает:
 * по ней preload пишет пульс — видно, у какого CLI журнал реально работает.
 */
export function ledgerEnv(
  install: LedgerInstall,
  appData: string,
  base: NodeJS.ProcessEnv,
): Record<string, string> {
  if (!install.preload) return {};
  return {
    NODE_OPTIONS: withPreload(base.NODE_OPTIONS, install.preload),
    AGENTDECK_VERIFY_LEDGER_HOME: ledgerHome(appData),
  };
}

/**
 * Установить и подмешать в окружение самой панели: дальше его наследует каждый
 * запуск — Claude, чужие CLI, локальные и контурные прогоны — без списка путей
 * запуска, который отстал бы от первого нового. Сама панель preload не грузит:
 * NODE_OPTIONS читается при старте процесса. Одна функция и для `runtime.ts`,
 * и для проверки окружения прогонов — проверка видит ровно то, что делает панель.
 */
export function activateLedger(appData: string, sourceDir: string): LedgerInstall {
  const install = installLedger({ appData, sourceDir, committedOnly: true });
  Object.assign(process.env, ledgerEnv(install, appData, process.env));
  return install;
}

function readEvents(home: string): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  for (const name of ['events.jsonl.1', 'events.jsonl']) {
    let text: string;
    try {
      text = readFileSync(join(home, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as LedgerEvent);
      } catch {
        /* строка, дописанная наполовину, — не событие */
      }
    }
  }
  return out;
}

/**
 * Сводка для плитки: сколько прогонов журнал повторил бы (или повторил), сколько
 * минут это сэкономило бы и сколько раз тень разошлась с настоящим прогоном —
 * последнее число обязано быть нулём, иначе включать повторы нельзя.
 */
export function ledgerSummary(
  appData: string,
  install: LedgerInstall,
  now = Date.now(),
  windowMs = 7 * 24 * 3600e3,
): LedgerSummary {
  const home = ledgerHome(appData);
  const events = readEvents(home).filter((e) => now - e.at <= windowMs);
  const count = (kind: string) => events.filter((e) => e.kind === kind).length;
  const saved = events
    .filter((e) => e.kind === 'would-skip' || e.kind === 'hit')
    .reduce((sum, e) => sum + (e.savedMs ?? 0), 0);
  const offReasons: Record<string, number> = {};
  for (const e of events) {
    if (e.kind === 'off' && e.reason) offReasons[e.reason] = (offReasons[e.reason] ?? 0) + 1;
  }
  const repos = new Set(events.map((e) => e.repo).filter(Boolean));
  let seen: LedgerSummary['seen'] = [];
  try {
    seen = readdirSync(join(home, 'seen'))
      .filter((n) => n.endsWith('.json'))
      .map(
        (n) =>
          JSON.parse(readFileSync(join(home, 'seen', n), 'utf8')) as { cli: string; at: number },
      )
      .map(({ cli, at }) => ({ cli, at }));
  } catch {
    /* ещё ни одного пульса */
  }
  return {
    active: Boolean(install.preload),
    reason: install.reason ?? null,
    version: install.version ?? null,
    mode: modeOf(process.env[LEDGER_ENV]),
    windowDays: Math.round(windowMs / (24 * 3600e3)),
    records: count('record'),
    wouldSkip: count('would-skip'),
    hits: count('hit'),
    mismatches: count('mismatch'),
    savedMs: saved,
    repos: repos.size,
    offReasons,
    seen,
  };
}

/** Итог уборки хранилища (`ledger.cjs` prune). */
export interface LedgerPruneResult {
  keys: number;
  drop: { dead: number; lru: number; orphans: number; tmp: number; flaky: number };
  bytes: { before: number; after: number };
}

interface LedgerModule {
  repoOf: (cwd: string) => { off?: string };
  prune: (repo: object, opts: { removed: string[] }) => LedgerPruneResult;
}

/** Исходники журнала в репозитории панели — тот же путь, что ставит `runtime.ts`. */
const LEDGER_SOURCE = fileURLToPath(new URL('../../../../../tools/verify-ledger', import.meta.url));

/**
 * Уборка записей убранной копии группы: ключи, которых касалась только она, уходят
 * сразу, а не через срок (владелец 24.10: записи живут, пока жива работа, — до уборки
 * группы). Записи, которые повторяла и живая работа (основная папка, соседняя копия),
 * остаются. Зовёт тот, кто убирает копию (`split-cleanup.ts` `removeGroupCopy`, после
 * `removeWorktree`); сбой уборки — `null`, саму уборку копии он не останавливает.
 */
export function pruneLedgerForRemovedCopy(input: {
  projectPath: string;
  copyPath: string;
  sourceDir?: string;
}): LedgerPruneResult | null {
  try {
    const load = createRequire(import.meta.url);
    const ledger = load(join(input.sourceDir ?? LEDGER_SOURCE, 'ledger.cjs')) as LedgerModule;
    const repo = ledger.repoOf(input.projectPath);
    if (repo.off) return null;
    return ledger.prune(repo, { removed: [input.copyPath] });
  } catch {
    return null;
  }
}

function modeOf(value: string | undefined): LedgerSummary['mode'] {
  const v = String(value ?? '').toLowerCase();
  // Пусто — значит on, как modeOf в самом preload (ledger.cjs): плитка не врёт о режиме.
  return v === 'shadow' || v === 'off' || v === 'disabled' ? v : 'on';
}

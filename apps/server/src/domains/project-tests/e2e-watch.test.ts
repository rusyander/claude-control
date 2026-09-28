import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectTestE2eSync } from '@agentdeck/contracts';
import type { WatcherLike } from '../../lib/config-watcher.ts';
import {
  createE2eWatch,
  defaultCreateWatcher,
  ignoredInE2e,
  type E2eWatchDeps,
} from './e2e-watch.ts';
import type { EventEmitter } from 'node:events';
import { createE2eFolder } from './e2e-folder.ts';
import { readGroups } from './store.ts';

/**
 * Наблюдение за папкой e2e вместо кнопки «Сверить». Проверяется то, ради чего
 * оно устроено окном и реестром: пачка сохранений — одна сверка, прогон,
 * пишущий в проект, сверку откладывает, а не теряет, выводы раннера и сама
 * библиотека её не будят, и убранный из реестра проект больше не наблюдается.
 */

interface FakeWatcher extends WatcherLike {
  dir: string;
  closed: boolean;
  emit: (path: string) => void;
}

const ROOT = join(tmpdir(), 'cc-e2e-watch-fake');
const DIR = join(ROOT, 'e2e');
const SYNCED: ProjectTestE2eSync = {
  dir: 'e2e',
  files: 1,
  tests: 1,
  added: 1,
  linked: 0,
  groups: ['auth'],
  skipped: [],
  missing: [],
};

describe('project-tests/e2e-watch: окно, занятость, реестр', () => {
  let watchers: FakeWatcher[] = [];
  let clock = 0;
  let roots: string[] = [];
  let busy = false;
  let folder: string | undefined = DIR;
  const syncs: { root: string; since: number }[] = [];
  const broadcasts: [string[], string][] = [];
  let folderLookups = 0;

  const deps = (): E2eWatchDeps => ({
    roots: () => roots,
    isBusy: () => busy,
    broadcast: (domains, path) => broadcasts.push([domains, path]),
    now: () => clock,
    folderOf: () => {
      folderLookups += 1;
      return folder;
    },
    syncFolder: (root, since) => {
      syncs.push({ root, since });
      return SYNCED;
    },
    createWatcher: (dir) => {
      let handler: ((event: string, path: string) => void) | undefined;
      const watcher: FakeWatcher = {
        dir,
        closed: false,
        on: (_event, next) => {
          handler = next;
          return watcher;
        },
        close: () => {
          watcher.closed = true;
        },
        emit: (path) => handler?.('change', path),
      };
      watchers.push(watcher);
      return watcher;
    },
  });

  /** Сдвинуть и часы наблюдателя, и таймеры — они живут в одном времени. */
  const advance = (ms: number): void => {
    clock += ms;
    vi.advanceTimersByTime(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    watchers = [];
    clock = 1_000_000;
    roots = [ROOT];
    busy = false;
    folder = DIR;
    syncs.length = 0;
    broadcasts.length = 0;
    folderLookups = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('десять сохранений подряд — одна сверка и одно событие, с началом окна', () => {
    const watch = createE2eWatch(deps());
    watch.sync();
    expect(watch.watched()).toEqual({ [ROOT]: DIR });

    const first = clock;
    for (let i = 0; i < 10; i += 1) {
      watchers[0]?.emit(join(DIR, `auth-${i}.spec.ts`));
      advance(200);
    }
    expect(syncs).toHaveLength(0);
    advance(1500);

    expect(syncs).toEqual([{ root: ROOT, since: first - 1500 }]);
    expect(broadcasts).toEqual([[['project-tests'], ROOT]]);
    // Сверка без событий не повторяется сама.
    advance(60_000);
    expect(syncs).toHaveLength(1);
  });

  it('непрерывная запись не откладывает сверку дольше потолка окна', () => {
    const watch = createE2eWatch(deps());
    watch.sync();
    for (let i = 0; i < 30; i += 1) {
      watchers[0]?.emit(join(DIR, 'auth.spec.ts'));
      advance(1000);
    }
    // 30 с непрерывных событий: сверки идут по потолку (10 с), а не одна в конце
    // и не по одной на событие.
    expect(syncs.length).toBeGreaterThanOrEqual(2);
    expect(syncs.length).toBeLessThanOrEqual(3);
  });

  it('проект занят прогоном — сверка ждёт его конца и не теряет окно', () => {
    const watch = createE2eWatch(deps());
    watch.sync();
    busy = true;
    const first = clock;
    watchers[0]?.emit(join(DIR, 'auth.spec.ts'));
    advance(30_000);
    expect(syncs).toHaveLength(0);

    busy = false;
    advance(5000);
    expect(syncs).toEqual([{ root: ROOT, since: first - 1500 }]);
  });

  it('выводы раннера, скрытые каталоги и библиотека кейсов сверку не будят', () => {
    const watch = createE2eWatch(deps());
    watch.sync();
    for (const path of [
      join(DIR, 'test-results', 'auth-chromium', 'trace.zip'),
      join(DIR, 'playwright-report', 'index.html'),
      join(DIR, '.auth', 'user.json'),
      join(DIR, 'node_modules', 'x', 'index.js'),
    ]) {
      watchers[0]?.emit(path);
    }
    advance(20_000);
    expect(syncs).toHaveLength(0);

    expect(ignoredInE2e(ROOT, ROOT, join(ROOT, '.agent', 'tests', 'auth.tests.json'))).toBe(true);
    expect(ignoredInE2e(ROOT, DIR, join(DIR, 'flows', 'auth.spec.ts'))).toBe(false);
  });

  it('сверка без изменений — без события; сбой сверки — в журнал, наблюдение живо', () => {
    let result: ProjectTestE2eSync | undefined = undefined;
    let fail = false;
    const logged: string[] = [];
    const watch = createE2eWatch({
      ...deps(),
      syncFolder: () => {
        if (fail) throw new Error('битая группа');
        return result;
      },
      log: (message) => logged.push(message),
    });
    watch.sync();
    watchers[0]?.emit(join(DIR, 'auth.spec.ts'));
    advance(2000);
    expect(broadcasts).toHaveLength(0);

    fail = true;
    watchers[0]?.emit(join(DIR, 'auth.spec.ts'));
    advance(2000);
    expect(logged).toHaveLength(1);

    fail = false;
    result = SYNCED;
    watchers[0]?.emit(join(DIR, 'auth.spec.ts'));
    advance(2000);
    expect(broadcasts).toHaveLength(1);
  });

  it('проект убрали из реестра — наблюдатель закрыт, начатое окно не сверяется', () => {
    const watch = createE2eWatch(deps());
    watch.sync();
    watchers[0]?.emit(join(DIR, 'auth.spec.ts'));

    roots = [];
    watch.sync();
    expect(watchers[0]?.closed).toBe(true);
    expect(watch.watched()).toEqual({});
    advance(20_000);
    expect(syncs).toHaveLength(0);
  });

  it('повторный sync ничего не пересоздаёт; тумблер наблюдения гасит всё', () => {
    const watch = createE2eWatch(deps());
    watch.sync();
    watch.sync();
    watch.sync();
    expect(watchers).toHaveLength(1);
    expect(folderLookups).toBe(1);

    roots = [];
    watch.sync();
    expect(watchers[0]?.closed).toBe(true);
  });

  it('папки нет — переспрос не чаще минуты; refresh — сразу', () => {
    folder = undefined;
    const watch = createE2eWatch(deps());
    watch.sync();
    advance(10_000);
    watch.sync();
    expect(folderLookups).toBe(1);
    expect(watchers).toHaveLength(0);

    advance(60_000);
    watch.sync();
    expect(folderLookups).toBe(2);

    folder = DIR;
    // Windows не различает регистр: путь из маршрута и из реестра — один проект.
    watch.refresh(process.platform === 'win32' ? ROOT.toUpperCase() : ROOT);
    expect(watchers).toHaveLength(1);
    expect(watch.watched()).toEqual({ [ROOT]: DIR });

    // Папку убрали — refresh закрывает наблюдателя.
    folder = undefined;
    watch.refresh(ROOT);
    expect(watchers[0]?.closed).toBe(true);
    expect(watch.watched()).toEqual({});
  });

  /** F-346. Наблюдаемую папку убрали и завели другую мимо маршрута. */
  it('папку перенесли мимо маршрута — через минуту наблюдается новая', () => {
    const watch = createE2eWatch(deps());
    watch.sync();
    expect(watch.watched()).toEqual({ [ROOT]: DIR });

    const moved = join(ROOT, 'qa', 'flows');
    folder = moved;
    advance(10_000);
    watch.sync();
    expect(watchers).toHaveLength(1);

    advance(60_000);
    watch.sync();
    expect(watchers[0]?.closed).toBe(true);
    expect(watchers[1]?.dir).toBe(moved);
    expect(watch.watched()).toEqual({ [ROOT]: moved });
  });

  it('close гасит наблюдателей и ждущие окна', () => {
    const watch = createE2eWatch(deps());
    watch.sync();
    watchers[0]?.emit(join(DIR, 'auth.spec.ts'));
    watch.close();
    advance(20_000);
    expect(watchers[0]?.closed).toBe(true);
    expect(syncs).toHaveLength(0);
  });
});

/**
 * Настоящий путь: chokidar над временным проектом, папка, заведённая панелью,
 * настоящая сверка. Тест, дописанный в папку, становится кейсом без единого
 * запроса к панели.
 */
describe('project-tests/e2e-watch: настоящая папка и настоящая сверка', () => {
  let root = '';
  let appData = '';

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-e2e-watch-')));
    appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-e2e-watch-data-')));
  });

  afterEach(() => {
    for (const target of [root, appData]) {
      try {
        rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // Остаётся в temp.
      }
    }
  });

  it('новый спек в папке — кейс в библиотеке и событие раздела', async () => {
    createE2eFolder(appData, root, '2026-09-27T10:00:00.000Z');
    const broadcasts: string[] = [];
    const watch = createE2eWatch({
      roots: () => [root],
      isBusy: () => false,
      appData,
      broadcast: (domains, path) => broadcasts.push(`${domains.join(',')}|${path}`),
    });
    watch.sync();
    try {
      expect(Object.values(watch.watched())).toEqual([join(root, 'e2e')]);
      // Дать chokidar обойти папку: событие до готовности наблюдателя теряется.
      await new Promise((done) => setTimeout(done, 800));
      mkdirSync(join(root, 'e2e', 'flows'), { recursive: true });
      writeFileSync(
        join(root, 'e2e', 'flows', 'cart.spec.ts'),
        "import { test } from '@playwright/test';\ntest('[cart-001] кладёт товар в корзину', async () => {});\n",
      );

      await vi.waitFor(
        () => {
          const cases = readGroups(root).flatMap((group) => group.cases.map((item) => item.id));
          expect(cases).toContain('cart-001');
        },
        { timeout: 15_000, interval: 200 },
      );
      expect(broadcasts).toContain(`project-tests|${root}`);
    } finally {
      watch.close();
    }
  }, 30_000);
});

// Ревью 28.09 (F-30): папка e2e с подпапкой без прав на чтение роняла сервер на
// каждом старте — ошибка chokidar шла в процесс, слушателя 'error' не было.
describe('ошибка настоящего наблюдателя e2e', () => {
  it('EPERM уходит в лог, наблюдение живо', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-e2e-watch-err-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const watcher = defaultCreateWatcher(dir, () => false) as unknown as EventEmitter & WatcherLike;
    try {
      const error = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      expect(() => watcher.emit('error', error)).not.toThrow();
      expect(warn).toHaveBeenCalledWith('e2e watch: watcher error', error);
    } finally {
      warn.mockRestore();
      await watcher.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

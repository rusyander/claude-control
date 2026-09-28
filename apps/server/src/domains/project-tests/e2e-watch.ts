import { resolve, sep } from 'node:path';
import { watch } from 'chokidar';
import type { ProjectTestE2eSync } from '@agentdeck/contracts';
import { surviveWatchErrors, type WatcherLike } from '../../lib/config-watcher.ts';
import { e2eFolderView, RUNNER_OUTPUT_DIRS, SKIP_DIRS } from './e2e-folder.ts';
import { syncE2eIfChanged } from './e2e-sync.ts';
import { TESTS_DIR } from './files.ts';

/**
 * Наблюдение за папкой e2e проектов: тест, дописанный в редакторе, терминале
 * или чужим CLI, становится кейсом сам, без кнопки «Сверить».
 *
 * Устроено как наблюдатель конфигов (`lib/config-watcher.ts`): не «запустить»,
 * а «привести к текущему состоянию» (`sync`). Список проектов читается на
 * каждый `sync` из реестра — убранный проект перестаёт наблюдаться на первом же
 * изменяющем запросе, а тумблер «следить за изменениями файлов» гасит и это
 * наблюдение.
 *
 * Чего модуль не допускает — лавины сверок:
 *   - события копятся окном (`DEBOUNCE_MS` тишины, но не дольше `MAX_WAIT_MS`
 *     от первого): сохранение десятка файлов — одна сверка;
 *   - пока проект держит прогон агента или идут автотесты, сверка ждёт: оба
 *     пишут в те же файлы групп, а раннер сыплет событиями отчётов;
 *   - каталоги отчётов раннера (`test-results`, `playwright-report`…) и
 *     библиотека кейсов не наблюдаются вовсе: сверка пишет в библиотеку, и
 *     наблюдение за ней будило бы само себя.
 */

/** Сколько тишины ждать после последнего события, мс. */
const DEBOUNCE_MS = 1500;

/** Дольше этого от первого события сверка не откладывается, мс. */
const MAX_WAIT_MS = 10_000;

/** Как часто переспрашивать занятый проект, мс. */
const BUSY_RETRY_MS = 5000;

/** Проект без папки e2e переспрашивается не чаще, мс: обход проекта не бесплатен. */
const MISSING_RECHECK_MS = 60_000;

const RUNNER_OUTPUT = RUNNER_OUTPUT_DIRS;

export interface E2eWatchDeps {
  /** Проекты под наблюдением сейчас; пусто — наблюдение выключено. */
  roots: () => string[];
  /** Идёт ли прогон, пишущий в проект (агент раздела или автотесты). */
  isBusy: (root: string) => boolean;
  /** Каталог данных панели: в нём запись о заведённой панелью папке. */
  appData?: string;
  /** Разослать событие подписчикам `/api/events`. */
  broadcast: (domains: string[], path: string) => void;
  /** Подмена chokidar — только для тестов. */
  createWatcher?: (dir: string, ignored: (path: string) => boolean) => WatcherLike;
  /** Подмена сверки — только для тестов. */
  syncFolder?: (root: string, sinceMs: number, now: string) => ProjectTestE2eSync | undefined;
  /** Подмена часов — только для тестов. */
  now?: () => number;
  /** Подмена поиска папки — только для тестов. */
  folderOf?: (root: string) => string | undefined;
  log?: (message: string, error: unknown) => void;
}

export interface E2eWatch {
  /** Привести наблюдение к реестру проектов (идемпотентно, дёшево). */
  sync: () => void;
  /** Папку проекта завели, убрали или сменили — перечитать её сейчас. */
  refresh: (root: string) => void;
  /** За какими папками следим: проект → абсолютный путь папки. */
  watched: () => Record<string, string>;
  close: () => void;
}

interface Watched {
  root: string;
  dir?: string;
  watcher?: WatcherLike;
  checkedAt: number;
  /** Время первого события неразобранного окна; пусто — окна нет. */
  firstAt?: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Ключ проекта: Windows не различает `C:\work` и `c:/work`. */
function keyOf(root: string): string {
  const full = resolve(root);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

/** Путь внутри наблюдаемой папки, который не повод сверять. */
export function ignoredInE2e(root: string, dir: string, path: string): boolean {
  const library = keyOf(resolve(root, ...TESTS_DIR.split('/')));
  const full = keyOf(path);
  if (full === library || full.startsWith(`${library}${sep}`)) return true;
  // Скрытые каталоги пропускает и сама сверка (`e2eChangedSince`); туда же
  // раннеры кладут своё (`.auth` с сохранённым входом пишется каждым прогоном).
  const inside = full.slice(keyOf(dir).length).split(/[\\/]/).filter(Boolean);
  return inside.some(
    (part) => part.startsWith('.') || SKIP_DIRS.has(part) || RUNNER_OUTPUT.has(part),
  );
}

export const defaultCreateWatcher = (
  dir: string,
  ignored: (path: string) => boolean,
): WatcherLike =>
  surviveWatchErrors(
    watch(dir, {
      ignoreInitial: true,
      ignored,
      // Редактор сохраняет файл в несколько приёмов: без задержки сверка читала бы
      // недописанный спек и заводила кейс из половины теста.
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      depth: 8,
    }),
    'e2e watch',
  );

const defaultFolderOf =
  (appData: string | undefined) =>
  (root: string): string | undefined => {
    const folder = e2eFolderView(root, appData);
    return folder.state === 'missing' || !folder.dir ? undefined : resolve(root, folder.dir);
  };

export function createE2eWatch(deps: E2eWatchDeps): E2eWatch {
  const create = deps.createWatcher ?? defaultCreateWatcher;
  const clock = deps.now ?? Date.now;
  const folderOf = deps.folderOf ?? defaultFolderOf(deps.appData);
  const syncFolder =
    deps.syncFolder ??
    ((root: string, sinceMs: number, now: string) =>
      syncE2eIfChanged(root, sinceMs, now, deps.appData));
  const entries = new Map<string, Watched>();

  const clearTimer = (entry: Watched): void => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
  };

  const unwatch = (entry: Watched): void => {
    clearTimer(entry);
    entry.firstAt = undefined;
    try {
      void entry.watcher?.close();
    } catch {
      // Закрытие наблюдателя — уборка; его сбой ничего не портит.
    }
    entry.watcher = undefined;
    entry.dir = undefined;
  };

  const schedule = (entry: Watched, delay: number): void => {
    clearTimer(entry);
    entry.timer = setTimeout(() => flush(entry), delay);
    // Таймер окна не должен держать процесс живым на выходе.
    entry.timer.unref?.();
  };

  const flush = (entry: Watched): void => {
    entry.timer = undefined;
    if (entry.firstAt === undefined || entries.get(keyOf(entry.root)) !== entry) return;
    if (deps.isBusy(entry.root)) {
      // Окно не сбрасывается: изменения, сделанные во время прогона, сверятся
      // после него — с того же первого события.
      schedule(entry, BUSY_RETRY_MS);
      return;
    }
    // Запас на задержку доставки: событие приходит после конца записи.
    const since = entry.firstAt - DEBOUNCE_MS;
    entry.firstAt = undefined;
    try {
      const result = syncFolder(entry.root, since, new Date(clock()).toISOString());
      if (result) deps.broadcast(['project-tests'], entry.root);
    } catch (error) {
      deps.log?.('e2e folder sync after a file change failed', error);
    }
  };

  const onEvent = (entry: Watched): void => {
    const at = clock();
    if (entry.firstAt === undefined) entry.firstAt = at;
    const waited = at - entry.firstAt;
    schedule(entry, Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - waited)));
  };

  const attach = (entry: Watched): void => {
    entry.checkedAt = clock();
    let dir: string | undefined;
    try {
      dir = folderOf(entry.root);
    } catch (error) {
      deps.log?.('e2e folder lookup failed', error);
    }
    if (dir === entry.dir && (entry.watcher || !dir)) return;
    unwatch(entry);
    if (!dir) return;
    const folder = dir;
    entry.dir = folder;
    entry.watcher = create(folder, (path) => ignoredInE2e(entry.root, folder, path));
    entry.watcher.on('all', (_event, path) => {
      if (ignoredInE2e(entry.root, folder, path)) return;
      onEvent(entry);
    });
  };

  const sync = (): void => {
    const wanted = new Map(deps.roots().map((root) => [keyOf(root), root]));
    for (const [key, entry] of entries) {
      if (wanted.has(key)) continue;
      unwatch(entry);
      entries.delete(key);
    }
    for (const [key, root] of wanted) {
      const entry = entries.get(key);
      if (!entry) {
        const fresh: Watched = { root, checkedAt: 0 };
        entries.set(key, fresh);
        attach(fresh);
      } else if (clock() - entry.checkedAt >= MISSING_RECHECK_MS) {
        // Папку могли завести, убрать или перенести мимо маршрута (чат,
        // терминал) — переспросить; прежняя папка иначе «наблюдалась» вечно.
        attach(entry);
      }
    }
  };

  return {
    sync,
    refresh: (root) => {
      const entry = entries.get(keyOf(root));
      if (entry) attach(entry);
    },
    watched: () =>
      Object.fromEntries(
        [...entries.values()]
          .filter((entry) => entry.watcher && entry.dir)
          .map((entry) => [entry.root, entry.dir ?? '']),
      ),
    close: () => {
      for (const entry of entries.values()) unwatch(entry);
      entries.clear();
    },
  };
}

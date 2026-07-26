import { watch } from 'chokidar';
import type { ClaudePaths } from '@claude-control/contracts';

/**
 * Наблюдатель за файлами конфигурации Claude Code.
 *
 * Раньше он поднимался ровно один раз при старте процесса прямо в `index.ts`:
 * тумблер «следить за изменениями файлов» и каталог конфигурации оказывались
 * заморожены до перезапуска сервера. Выключенный тумблер продолжал слать
 * события и дёргать интерфейс, включённый обратно не делал ничего, а после
 * смены каталога панель следила за ЧУЖИМИ файлами: правки в новом каталоге не
 * обновляли её, а правки в старом давали фантомные обновления.
 *
 * Поэтому здесь не «запустить», а «привести к текущему состоянию» (`sync`):
 * вызывающий дёргает его после любого изменяющего запроса, а модуль сам решает,
 * что делать — поднять, погасить или пересоздать с новыми путями. Логика
 * вынесена из `index.ts` ещё и потому, что тот исполняется как точка входа
 * (слушает порт) и в тесте не импортируется.
 */

/** Минимум, что нужно от chokidar; в тестах подставляем управляемый фейк. */
export interface WatcherLike {
  on(event: 'all', handler: (event: string, path: string) => void): unknown;
  close(): unknown;
}

export interface ConfigWatcherDeps {
  /** Текущее состояние: смотреть ли вообще и за какими путями. */
  read: () => { enabled: boolean; paths: ClaudePaths };
  /** Разослать событие подписчикам `/api/events`. */
  broadcast: (domains: string[], path: string) => void;
  /** Подмена chokidar — только для тестов. */
  createWatcher?: (paths: string[]) => WatcherLike;
}

export interface ConfigWatcher {
  /** Привести наблюдателя к текущим настройкам и путям (идемпотентно). */
  sync: () => void;
  /** Погасить наблюдателя совсем. */
  close: () => void;
  /** За чем следим сейчас — пусто, если наблюдение выключено. */
  watched: () => string[];
}

/** Файлы и каталоги конфигурации, изменения которых интересуют интерфейс. */
export function watchedPaths(paths: ClaudePaths): string[] {
  return [
    paths.settings,
    paths.settingsLocal,
    paths.claudeMd,
    paths.secretsEnv,
    paths.skills,
    paths.mcpConfig,
  ];
}

/** Какие разделы интерфейса перечитать из-за изменения этого файла. */
export function domainsForPath(paths: ClaudePaths, changedPath: string): string[] {
  if (changedPath.startsWith(paths.skills)) return ['skills'];
  if (changedPath === paths.claudeMd) return ['rules'];
  if (changedPath === paths.mcpConfig) return ['mcp'];
  if (changedPath === paths.secretsEnv) return ['env'];
  // Локальные настройки попадают в те же списки: панель показывает их наравне
  // с основными, поэтому и обновлять надо то же самое.
  if (changedPath === paths.settings || changedPath === paths.settingsLocal) {
    return ['hooks', 'permissions', 'env'];
  }
  return ['overview'];
}

const defaultCreateWatcher = (paths: string[]): WatcherLike =>
  watch(paths, {
    ignoreInitial: true,
    // Конфиги пишутся целиком, и без задержки прилетает событие на недописанный
    // файл — читать его бессмысленно, получим то старое, то битое содержимое.
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    depth: 3,
  });

export function createConfigWatcher(deps: ConfigWatcherDeps): ConfigWatcher {
  const create = deps.createWatcher ?? defaultCreateWatcher;

  let watcher: WatcherLike | undefined;
  /** Слепок того, что уже применено, — чтобы не пересоздавать наблюдателя зря. */
  let applied = '';

  const stop = (): void => {
    watcher?.close();
    watcher = undefined;
    applied = '';
  };

  const sync = (): void => {
    const { enabled, paths } = deps.read();
    if (!enabled) {
      stop();
      return;
    }

    const targets = watchedPaths(paths);
    const signature = targets.join('\n');
    // Ничего не изменилось — пересоздание только сожгло бы дескрипторы и
    // потеряло бы события на время повторного обхода дерева.
    if (watcher && signature === applied) return;

    stop();
    applied = signature;
    watcher = create(targets);
    // Пути читаем на момент события, а не замыкаем: каталог мог смениться
    // прямо во время доставки, и разбирать путь надо по актуальной карте.
    watcher.on('all', (_event, changedPath) => {
      deps.broadcast(domainsForPath(deps.read().paths, changedPath), changedPath);
    });
  };

  return {
    sync,
    close: stop,
    watched: () => (watcher ? applied.split('\n') : []),
  };
}

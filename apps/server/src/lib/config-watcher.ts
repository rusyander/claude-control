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

/**
 * Каталог транскриптов. Разговор ведёт не только панель: тот же чат идёт из
 * терминала, из расширения редактора, из второго окна — и дописывается прямо в
 * этот каталог. Без наблюдения за ним лента обновлялась ТОЛЬКО у прогона,
 * запущенного самой панелью, а чужой разговор приходилось догонять руками
 * через F5.
 */
export function projectsPath(paths: ClaudePaths): string {
  // Разделитель берём из самого каталога, а не у платформы: путь приходит и в
  // POSIX-виде (переменная окружения, настройка «свой каталог»), а `join` на
  // Windows превратил бы его в смешанный — и сравнение с путём из наблюдателя
  // перестало бы совпадать.
  const separator = paths.root.includes('\\') ? '\\' : '/';
  return `${paths.root.replace(/[\\/]+$/, '')}${separator}projects`;
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
    projectsPath(paths),
  ];
}

/** Какие разделы интерфейса перечитать из-за изменения этого файла. */
export function domainsForPath(paths: ClaudePaths, changedPath: string): string[] {
  // Сравниваем в едином написании: наблюдатель отдаёт путь в том виде, в каком
  // его вернула система, и на Windows он смешивает разделители.
  const slashed = (value: string): string => value.replace(/\\/g, '/');
  if (slashed(changedPath).startsWith(slashed(projectsPath(paths)))) return ['chats'];
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

/**
 * Насколько склеивать очередь событий.
 *
 * Транскрипт идущего разговора дописывается непрерывно, и без склейки панель
 * перечитывала бы ленту по нескольку раз в секунду. Задержка заметно меньше
 * времени реакции человека — сообщение всё равно появляется «сразу».
 */
const COALESCE_MS = 1000;

export function createConfigWatcher(deps: ConfigWatcherDeps): ConfigWatcher {
  const create = deps.createWatcher ?? defaultCreateWatcher;

  let watcher: WatcherLike | undefined;
  /** Слепок того, что уже применено, — чтобы не пересоздавать наблюдателя зря. */
  let applied = '';

  /** Что накопилось за окно склейки: разделы и последний задевший их путь. */
  let pending: { domains: Set<string>; path: string } | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    flushTimer = undefined;
    if (!pending) return;
    const { domains, path } = pending;
    pending = undefined;
    deps.broadcast([...domains], path);
  };

  const queue = (domains: string[], path: string): void => {
    if (!pending) pending = { domains: new Set(), path };
    for (const domain of domains) pending.domains.add(domain);
    pending.path = path;
    if (flushTimer) return;
    flushTimer = setTimeout(flush, COALESCE_MS);
    // Таймер склейки не должен держать процесс живым на выходе.
    flushTimer.unref?.();
  };

  const stop = (): void => {
    watcher?.close();
    watcher = undefined;
    applied = '';
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    pending = undefined;
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
      queue(domainsForPath(deps.read().paths, changedPath), changedPath);
    });
  };

  return {
    sync,
    close: stop,
    watched: () => (watcher ? applied.split('\n') : []),
  };
}

/**
 * Сторож групп разделения — фасад папки `group-watcher/`: класс сторожа, его
 * сигналы, файлы и затравки живут там отдельными модулями, а пути импорта
 * (проводка, проверки) остаются прежними.
 */
export { GroupWatcher } from './group-watcher/group-watcher.ts';
export { notifyKey } from './group-watcher/signal-recorder.ts';
export { IDLE_DROP_MS, WATCH_TICK_MS } from './group-watcher/timing.ts';
export { SILENT_ALERT_FACTOR } from './group-watcher/group-sweep.ts';
export { createRestartFeed } from './group-watcher/dev-restarts.ts';
export type { RestartFeed } from './group-watcher/restart-rules.ts';
export { createLedgerFeed, type LedgerSource } from './group-watcher/ledger-feed.ts';
export type {
  ChatSignalStore,
  DeferredStuck,
  GroupLive,
  GroupWatchFeed,
  GroupWatcherDeps,
  TranscriptHint,
  WatchSignalStore,
  WatchTarget,
} from './group-watcher/group-watcher.types.ts';

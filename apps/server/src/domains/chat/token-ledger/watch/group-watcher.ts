/**
 * Сторож групп разделения — фасад папки `group-watcher/`: класс сторожа, его
 * сигналы, файлы и затравки живут там отдельными модулями, а пути импорта
 * (проводка, проверки) остаются прежними.
 */
export { GroupWatcher } from './group-watcher/group-watcher.ts';
export { notifyKey } from './group-watcher/signal-recorder.ts';
export { IDLE_DROP_MS, WATCH_TICK_MS } from './group-watcher/timing.ts';
export { SILENT_ALERT_FACTOR } from './group-watcher/group-sweep.ts';
export type {
  ChatSignalStore,
  GroupLive,
  GroupWatchFeed,
  GroupWatcherDeps,
  TranscriptHint,
  WatchSignalStore,
  WatchTarget,
} from './group-watcher/group-watcher.types.ts';

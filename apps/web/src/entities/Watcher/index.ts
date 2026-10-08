export { useWatcherStatus } from './api/WatcherApi';
export { useSetWatcher } from './api/useSetWatcher';
export { useWatcherElapsed } from './model/elapsed';
export { elapsedMs } from './lib/elapsedMs';
export { watcherSpendText } from './model/spend';
export { WATCHER_ANCHOR, WATCHER_FOCUS_EVENT, watcherSettingsTab } from './model/anchor';
export type { WatcherStatus, WatcherSpend, WatcherProblem } from '@agentdeck/contracts';
export { WatcherSummary } from './ui/WatcherSummary';

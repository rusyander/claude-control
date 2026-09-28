export { useWatcherStatus, useSetWatcher } from './api/WatcherApi';
export { elapsedMs, useWatcherElapsed } from './model/elapsed';
export { watcherSpendText } from './model/spend';
export { WATCHER_ANCHOR, WATCHER_FOCUS_EVENT, watcherSettingsTab } from './model/anchor';
export type { WatcherStatus, WatcherSpend, WatcherProblem } from '@agentdeck/contracts';
export { WatcherSummary } from './ui/WatcherSummary';

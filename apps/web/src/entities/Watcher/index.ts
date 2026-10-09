export { useWatcherStatus } from './api/WatcherApi';
export { useSetWatcher } from './api/useSetWatcher';
export { useReportBug } from './api/useReportBug';
export { useWatcherReport } from './api/useWatcherReport';
export { useWatcherElapsed } from './model/elapsed';
export { elapsedMs } from './lib/elapsedMs';
export { watcherSpendText } from './model/spend';
export type {
  WatcherStatus,
  WatcherSpend,
  WatcherProblem,
  WatchUserCheck,
  WatchReportSection,
} from '@agentdeck/contracts';
export { WatcherSummary } from './ui/WatcherSummary';

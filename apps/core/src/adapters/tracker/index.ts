/** Трекеры ядра (этап 12, D15): Jira поверх общего клиента и сети ядра. */
export { createJiraTracker } from './jira.ts';
export { coreTransport, describeTransport } from './transport.ts';
export type { CoreTracker, TrackerAccess, TrackerFound, TrackerWrite } from './tracker.types.ts';

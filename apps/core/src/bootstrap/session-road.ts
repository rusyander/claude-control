/**
 * Дорога сессии ядра — тонкий фасад над `session-road/` (идиом разбиения модуля): каждый, кто
 * запускает сессию ядра, берёт её отсюда (загрузка кладёт готовую в `BootedCore.road`).
 */
export {
  createSessionRoad,
  DEFAULT_NODE_ARGV,
  NO_KEY,
  type LaunchOptions,
  type LaunchResult,
  type RoadDeps,
  type SessionRoad,
} from './session-road/road.ts';
export type {
  FoundResource,
  PrepareOutcome,
  Prepared,
  RoadAttach,
  RoadSession,
  RoadStart,
  SessionEnd,
  TaskRelease,
} from './session-road/road.types.ts';
export { memoLoginPath, type LoginPathReader } from './session-road/launch-env.ts';
export { journalRecorder } from './session-road/recorder.ts';
export { REAL_READERS, type ResourceReaders } from './session-road/resources.ts';

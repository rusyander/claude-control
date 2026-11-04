export {
  CORE_BACKOFF_MAX_MS,
  CORE_BACKOFF_MIN_MS,
  CORE_FAULT_FAILS,
  CORE_FAULT_WINDOW_MS,
  coreBackoffMs,
  createCoreSupervisor,
} from './core-supervisor.ts';
export type {
  CoreExit,
  CoreProbe,
  CoreSupervisor,
  CoreSupervisorDeps,
  SpawnedCore,
} from './core-supervisor.types.ts';
export {
  CORE_ENTRY,
  CORE_LOG_FILES,
  CORE_SUPERVISE_ENV,
  coreLaunchArgs,
  coreLaunchEnv,
  launchCore,
} from './launch.ts';
export { createCoreProbe, readCoreExit, readCoreLogTail } from './probe.ts';
export {
  autostartArgs,
  CORE_AUTOSTART_NAME_ENV,
  createCoreAutostart,
  runCoreCommand,
  type CoreAutostart,
} from './autostart.ts';

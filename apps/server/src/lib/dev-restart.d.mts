/** Типы для `dev-restart.mjs` — общий файл dev-сторожа и сервера. */

export type DevRestartWait = 'runs' | 'setup' | 'checks' | 'both';

export interface DevRestartFileState {
  pid: number;
  since: string;
  files: string[];
  waitingFor: DevRestartWait;
  capAt?: string;
  runs?: string[];
}

export interface DevRestartView {
  pending: boolean;
  since?: string;
  files?: string[];
  waitingFor?: DevRestartWait;
  capAt?: string;
  runs?: string[];
  requested?: boolean;
}

export declare const RUNS_WAIT_CAP_MS: number;
export declare function runsWaitCapped(
  sinceMs: number | undefined,
  now: number,
  capMs: number,
): boolean;

export declare const DEV_RESTART_STATE: string;
export declare const DEV_RESTART_REQUEST: string;
export declare const DEV_WATCH_LOG: string;
export declare function appendDevLog(appData: string, line: string): void;

export declare function writeRestartState(appData: string, state: DevRestartFileState): void;
export declare function clearRestartState(appData: string): void;
export declare function readRestartState(
  appData: string,
  isAlive?: (pid: number) => boolean,
): DevRestartView;
export declare function requestRestart(appData: string): void;
export declare function takeRestartRequest(appData: string): boolean;
export declare function deferReason(
  runsBusy: boolean,
  setupBusy: boolean,
  checksBusy?: boolean,
): DevRestartWait | undefined;

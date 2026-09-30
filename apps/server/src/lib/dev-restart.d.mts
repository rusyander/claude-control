/** Типы для `dev-restart.mjs` — общий файл dev-сторожа и сервера. */

export type DevRestartWait = 'runs' | 'setup' | 'both';

export interface DevRestartFileState {
  pid: number;
  since: string;
  files: string[];
  waitingFor: DevRestartWait;
}

export interface DevRestartView {
  pending: boolean;
  since?: string;
  files?: string[];
  waitingFor?: DevRestartWait;
  requested?: boolean;
}

export declare const DEV_RESTART_STATE: string;
export declare const DEV_RESTART_REQUEST: string;

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
): DevRestartWait | undefined;

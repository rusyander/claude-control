/** Типы для `dev-watch.mjs` — сам файл исполняется голым Node как dev-скрипт сервера. */

export declare function isWatched(path: string): boolean;

/** Журналы процессов проверок проекта, которых ждёт перезапуск (Ф11). */
export declare const CHECK_LEDGERS: readonly string[];

/** Журналы идущих ходов — Claude и чужих CLI (F2), с одним пределом ожидания. */
export declare const RUN_LEDGERS: readonly string[];

export declare function busyRun(
  entries: readonly unknown[],
  isAlive: (pid: number) => boolean,
): boolean;

/**
 * Ждать ли идущих ходов: живой ход — без предела, нечитаемый журнал без живого
 * хода — до `capMs` от начала отсрочки.
 */
export declare function runsWait(
  ledgers: readonly ({ value?: unknown; unreadable?: boolean } | undefined)[],
  isAlive: (pid: number) => boolean,
  deferredSince: number | undefined,
  now: number,
  capMs: number,
): { wait: boolean; capped: boolean; capAt?: string; runs: string[] };

/** Чтение атомарно переписываемого JSON с повтором промаха переименования (Windows). */
export declare function readJsonSteady(
  file: string,
  read?: (file: string, encoding: 'utf8') => string,
  attempts?: number,
): { value: unknown; unreadable?: undefined } | { unreadable: true; value?: undefined };

/** Идёт ли ход по журналу процессов; нечитаемый журнал — занято. */
export declare function ledgerBusy(
  file: string,
  isAlive: (pid: number) => boolean,
  read?: (file: string, encoding: 'utf8') => string,
): boolean;

/** Группа разделения готовит копию (стартовала, чата нет, моложе получаса). */
export declare function splitSetupRunning(state: unknown, now: number): boolean;

export declare const QUIET_MS: number;
export declare const MAX_WAIT_MS: number;

export declare class SourceWatcher {
  constructor(
    roots: string[],
    onChange: (files: string[]) => void,
    quietMs?: number,
    maxWaitMs?: number,
  );
  start(): this;
  close(): void;
  touched(path: string): void;
  waiting(): boolean;
  flushNow(): void;
}

/** Типы для `dev-watch.mjs` — сам файл исполняется голым Node как dev-скрипт сервера. */

export declare function isWatched(path: string): boolean;

/** Журналы процессов проверок проекта, которых ждёт перезапуск (Ф11). */
export declare const CHECK_LEDGERS: readonly string[];

export declare function busyRun(
  entries: readonly unknown[],
  isAlive: (pid: number) => boolean,
): boolean;

/** Группа разделения готовит копию (стартовала, чата нет, моложе получаса). */
export declare function splitSetupRunning(state: unknown, now: number): boolean;

export declare class SourceWatcher {
  constructor(roots: string[], onChange: (files: string[]) => void, debounceMs?: number);
  start(): this;
  close(): void;
}

/** Типы для `kill-tree.mjs` — сам файл без типов, его исполняют посредники чата и `tools/` голым Node. */

/** Строка снимка процессов: `created` — тики FILETIME (100 нс от 1601 UTC), `0n` — неизвестно. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  created: bigint;
}

export type TreeKillSkip = 'root-absent' | 'root-unknown' | 'root-reused';

export interface TreeKillPlan {
  /** Листьями вперёд, корень последним. */
  pids: number[];
  skipped?: TreeKillSkip;
}

export interface TreeKillOptions {
  /** Запуск был `detached` и процесс возглавляет свою группу (только POSIX). */
  group?: boolean;
  /**
   * Момент (мс Unix), когда номер точно принадлежал нашему процессу — сразу после
   * запуска или позже. Корень, созданный позже этого (с запасом `REUSE_SLACK_MS`),
   * — чужой процесс на освободившемся номере, и его не трогаем.
   */
  spawnedAt?: number;
  /** Кого никогда не снимать; по умолчанию — сам текущий процесс. */
  selfPid?: number;
  /** Зовётся перед сигналом каждому снимаемому номеру. */
  onKill?: (pid: number) => void;
  /**
   * Снять только потомков, корень оставить: посредник живой сессии сам скажет
   * код выхода CLI, если жив. Снимка нет — не снимается ничего.
   */
  keepRoot?: boolean;
}

export interface TreeKillImpl {
  platform?: string;
  readTable?: () => ProcessRow[] | undefined;
  /** Номера и группы POSIX (`ps -o pid=,pgid=`) — для группы без лидера. */
  readGroups?: () => PosixGroupRow[] | undefined;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * Снятие по дескриптору (Windows); `undefined` в ответе — помощник недоступен,
   * снимаем по номеру. Не задано при заданном `kill` — сразу по номеру.
   */
  terminate?: (targets: readonly KillTarget[]) => Map<number, KillOutcome> | undefined;
}

export interface PosixGroupRow {
  pid: number;
  pgid: number;
}

/** Форма `ChildProcess`, нужная для снятия: оба кода `null` — процесс жив и номер его. */
export interface KillableProcess {
  pid?: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | string | null;
  kill: (signal?: NodeJS.Signals) => boolean;
}

export declare const REUSE_SLACK_MS: number;
export declare function filetimeFromMs(ms: number): bigint;
export declare function planTreeKill(
  table: readonly ProcessRow[],
  rootPid: number,
  options?: Pick<TreeKillOptions, 'spawnedAt' | 'selfPid'>,
): TreeKillPlan;
export declare function parseProcessTable(text: string): ProcessRow[] | undefined;
/** Подменяемый запуск снимка — форма результата `spawnSync`, нужная разбору. */
export type SnapshotRun = (
  command: string,
  args: readonly string[],
  options: object,
) => { stdout?: unknown; status: number | null; error?: Error };
export declare function readProcessTable(run?: SnapshotRun): ProcessRow[] | undefined;
/** Номер и время создания из снимка — то, с чем сверяется дескриптор. */
export interface KillTarget {
  pid: number;
  created: bigint | undefined;
}
/** `reused` — номер держит процесс с другим временем создания: не наш, не тронут. */
export type KillOutcome = 'killed' | 'gone' | 'denied' | 'reused' | 'failed';
export declare function parseKillOutcomes(text: string): Map<number, KillOutcome> | undefined;
export declare function terminateByHandle(
  targets: readonly KillTarget[],
  run?: SnapshotRun,
): Map<number, KillOutcome> | undefined;
/** `etime` из `ps` (`[[дд-]чч:]мм:сс`) → секунды; не разобрать — `undefined`. */
export declare function etimeSeconds(text: string): number | undefined;
export declare function parsePosixProcessTable(
  text: string,
  nowMs: number,
): ProcessRow[] | undefined;
export declare function readPosixProcessTable(run?: SnapshotRun): ProcessRow[] | undefined;
export declare function killProcessTree(
  pid: number,
  options?: TreeKillOptions,
  impl?: TreeKillImpl,
): number[];
export declare function readPosixGroups(run?: SnapshotRun): PosixGroupRow[] | undefined;
export declare function killOrphanGroup(pgid: number, impl?: TreeKillImpl): number[];
export declare function childIsRunning(
  child: Pick<KillableProcess, 'exitCode' | 'signalCode'>,
): boolean;
export declare function killChildProcessTree(
  child: KillableProcess,
  options?: TreeKillOptions,
  impl?: TreeKillImpl,
): number[];
/**
 * Снять дерево и через `graceMs` (5 с) добить живой корень SIGKILL; возвращает отмену добивания.
 * `unref` — таймер не держит процесс; `impl.killChild` — своё снятие дерева вместо встроенного.
 */
export declare function stopTreeWithGrace<C extends KillableProcess>(
  child: C,
  options?: TreeKillOptions & { graceMs?: number; unref?: boolean },
  impl?: TreeKillImpl & { killChild?: (child: C) => void },
): () => void;

export declare const WATCH_SLACK_MS: number;
/** План добивания пережившего команду: `known` — `pid → created` замеченных потомков (Ф9). */
export declare function planLeftoverKill(
  table: readonly ProcessRow[],
  known: ReadonlyMap<number, bigint>,
  options?: { slackMs?: number; selfPid?: number },
): number[];
export declare function readProcessTableAsync(platform?: string): Promise<ProcessRow[] | undefined>;
export declare function killLeftovers(
  known: ReadonlyMap<number, bigint>,
  options?: { slackMs?: number; selfPid?: number },
  impl?: TreeKillImpl,
): number[];

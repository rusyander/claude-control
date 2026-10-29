import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  CheckAnswer,
  CheckDecisionInput,
  CheckEntry,
  CheckKey,
  CheckRecord,
  CheckRegistry,
  CheckRequest,
  QueueLease,
  RecordGrade,
} from '@agentdeck/contracts/core/records';
import type { KeyOf } from '../../../verifier/key/index.ts';
import type { RecordStore } from '../../../verifier/store/index.ts';
import type { CallerResult, CheckDeps } from '../checks.types.ts';
import type { Match } from '../match.ts';

export interface CheckService {
  requestCheck(req: CheckRequest): Promise<CheckAnswer>;
  /** Дороги захвата: вызывающий исполнил выданный argv под арендой — записать исход. */
  completeCheck(checkRunId: string, result: CallerResult): Promise<CheckAnswer>;
  /** Прогоны, выданные вызывающему и ещё не завершённые. */
  pending(): string[];
  /** Файл сжатого вывода записи в хранилище запроса; хранилище не читается — `null`. */
  logPath(req: CheckRequest, recordId: string): string | null;
}

export interface Gathered {
  store: Fact<RecordStore>;
  registry: Fact<CheckRegistry>;
  match: Match;
  selection: string[];
  key: Fact<KeyOf>;
  records: Fact<CheckRecord[]>;
  input: CheckDecisionInput;
}

export interface Held {
  lease: QueueLease;
  key: CheckKey | null;
  checkRunId: string;
  /** Номер, под которым взят ключ «в полёте»: повторы G4 идут своими номерами, ключ — этим. */
  claimRunId: string;
}

/** Ключ «в полёте» взял другой (или держатель не читается): ответ входа решает `requestCheck`. */
export interface Contended {
  contended: { checkRunId: string; since: number } | null;
  reason: string;
}

export interface Pending {
  req: CheckRequest;
  g: Gathered;
  entry: CheckEntry;
  unit: string;
  grade: RecordGrade;
  argv: string[];
  narrowed: boolean;
  held: Held;
  startedAt: number;
  epochBefore: number | null;
  timer: ReturnType<typeof setInterval>;
  deadline: ReturnType<typeof setTimeout>;
}

/**
 * Состояние одного входа (`createCheckService`): опоры и то, что живёт между вызовами. Модули
 * папки получают его первым аргументом вместо замыкания.
 */
export interface ServiceState {
  deps: CheckDeps;
  poll: number;
  run: NonNullable<CheckDeps['run']>;
  pending: Map<string, Pending>;
  /** Строки журнала, которые задача не приняла, — по запросу: уходят в ближайший ответ `ran`. */
  lost: WeakMap<CheckRequest, string[]>;
}

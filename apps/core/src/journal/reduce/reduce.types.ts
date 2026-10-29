import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type {
  AskState,
  CheckRunState,
  PublishState,
  SessionState,
  StepState,
  TaskState as TaskMachineState,
  UnitState,
} from '@agentdeck/contracts/core/states';

/**
 * Состояние задачи = свёртка журнала (01 §State). Ничего здесь не хранится иначе как через
 * событие; снимок — производный и пересобирается из журнала.
 */

/** Меняется, когда меняется форма состояния: снимок другой версии не используется. */
// 2: `CommandRecord.bodyHash` (ревью M1) — снимки версии 1 его не несут, открытие идёт полным проходом.
// 3: `StepRecord.claim` из `step.claimed`.
// 4: `CommandRecord.masked` (ревью F-25); повторное create-событие — аномалия, запись не
//    трогается (ревью F-52).
// 5: `CheckRunRecord.run` из `check.requested` и `recordId` из `check.recorded` (G24).
export const REDUCER_VERSION = 5;

/**
 * Прогон проверки в свёртке (G24): после краха возобновить или снять его можно, только зная, что
 * это за прогон, — проверка, единица, ключ. `run` нет у прогона, начатого одним переходом без
 * `check.requested` (журналы до этапа 3): такой виден, но возобновлению не подлежит.
 */
export interface CheckRunRecord {
  state: CheckRunState;
  run?: JournalDataV1['check.requested'];
  recordId?: string;
}

export interface ActionRecord {
  kind: JournalDataV1['action.started']['kind'];
  target: string;
  idempotencyHint: string;
  /** `awaiting-human` — сверка не узнала исход и задала вопрос (точка 4). */
  status: 'started' | 'awaiting-human' | 'done' | 'failed';
  startedSeq: number;
  startedAt: number;
  code?: string;
}

export interface CommandRecord {
  kind: string;
  status: 'received' | 'applied' | 'rejected';
  receivedSeq: number;
  /** Доказательство приёма — по нему решает и ядро, принявшее команду до краха. */
  proof: JournalDataV1['command.received']['proof'];
  /** Отпечаток принятого тела (`command-body.ts`): повтор `cmdId` с другим телом — отказ. */
  bodyHash: string;
  /**
   * Тело легло в журнал с маской DLP (`masked` строки > 0): `bodyHash` посчитан по
   * маскированному телу, и повтор сравнивается с ним только через ту же маску (ревью F-25).
   */
  masked?: boolean;
  outcomeSeq?: number;
  code?: string;
  reason?: string;
  outcome?: unknown;
}

export interface StepRecord {
  state: StepState;
  unitId: string;
  stepKind: string;
  /** Последнее принятое заявление `step_done` (`step.claimed`) и номер его строки. */
  claim?: { seq: number; call: JournalDataV1['step.claimed']['claim'] };
}

export interface SessionRecord {
  state: SessionState;
  stepId: string;
  adapter: string;
  route: JournalDataV1['session.started']['route'];
  modelAsked: string;
  modelServed: string | null;
  hostPid: number;
  hostStart: string;
  cliPid: number | null;
  cliStart: string | null;
}

export interface TaskFoldState {
  reducer: number;
  taskId: string;
  seq: number;
  lastAt: number | null;
  created: JournalDataV1['task.created'] | null;
  task: TaskMachineState;
  ended: JournalDataV1['task.ended']['outcome'] | null;
  units: Record<string, { state: UnitState; branch: string }>;
  steps: Record<string, StepRecord>;
  sessions: Record<string, SessionRecord>;
  checks: Record<string, CheckRunRecord>;
  asks: Record<string, { state: AskState; point: number }>;
  publish: Record<string, { state: PublishState }>;
  actions: Record<string, ActionRecord>;
  commands: Record<string, CommandRecord>;
  resources: Record<string, { kind: string; status: 'live' | 'released' | 'verified' | 'leak' }>;
  lease: { leaseId: string | null; takeovers: number };
  counters: { masked: number; repairedBytes: number; errors: number; clockJumps: number };
  /** Рабочее время по `mono` одной загрузки, без пауз, ожиданий и сна (01 §Time, P56). */
  work: { activeMs: number; lastMono: number | null; lastBootId: string | null };
  /** Событие, противоречащее машине состояний: показано, не применено. */
  anomalies: { seq: number; reason: string }[];
}

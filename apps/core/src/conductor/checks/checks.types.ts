import type { Fact } from '@agentdeck/contracts/core/facts';
import type { JournalDataV1, JournalKind } from '@agentdeck/contracts/core/journal';
import type {
  CheckEntry,
  CheckRegistry,
  CheckRequest,
  QuarantineEntry,
  ServiceEndpoint,
  ServiceNeed,
  Unmet,
} from '@agentdeck/contracts/core/records';
import type { CheckQueue } from '../../verifier/queue/queue.ts';
import type { RunDeps, RunLease, RunResult, RunSpec } from '../../verifier/run/run.types.ts';
import type { KeyOf } from '../../verifier/key/index.ts';
import type { RecordStore } from '../../verifier/store/index.ts';

/** Строка журнала задачи, которую пишет вход проверки (G24): вид + данные + шаг. */
export type CheckJournalKind = Extract<
  JournalKind,
  'check.requested' | 'check.transition' | 'check.recorded' | 'decision'
>;
export interface CheckJournalEntry<K extends CheckJournalKind = CheckJournalKind> {
  kind: K;
  stepId: string | null;
  data: JournalDataV1[K];
}

export interface KeyInput {
  req: CheckRequest;
  entry: CheckEntry;
  registry: CheckRegistry;
  unit: string;
  selection: string[];
}

/**
 * Всё, на что опирается `requestCheck`: чтения (реестр, ключ, записи), очередь, прогон, журнал.
 * Обвязка (`bootstrap/verifier-wiring/queue.ts`) даёт настоящие; тесты подменяют только внешнюю
 * границу (дерево git, часы), а решение, очередь и прогон — настоящие.
 */
export interface CheckDeps {
  queue: CheckQueue;
  /** Хранилище записей репозитория запроса (одно на общий каталог git, 04:33). */
  store(req: CheckRequest): Fact<RecordStore>;
  registry(req: CheckRequest): Promise<Fact<CheckRegistry>>;
  key(input: KeyInput): Promise<Fact<KeyOf>>;
  /** Пин окружения задачи (зона E); из окружения ядра — ничего (P25). */
  env(req: CheckRequest): Promise<Fact<Record<string, string>>>;
  standEpoch: RunDeps['standEpoch'];
  /**
   * Сервисы записи (`entry.needs`, 04:124) — подняты до прогона, адреса в окружении копии. Не
   * `value` (нет движка, рецепта, готовности) или входа нет — прогона нет, запись
   * `no-verdict(env)` с причиной (P58), никогда не зелёный.
   */
  services?(req: CheckRequest, needs: readonly ServiceNeed[]): Promise<Fact<ServiceEndpoint[]>>;
  journal(taskId: string, entry: CheckJournalEntry): void;
  /**
   * Журнал задачи не принял строку (задача снята, схема, диск): обвязка называет потерю в своём
   * журнале — молча пропавшая строка не видна при сверке (A1r4-F10).
   */
  onJournalLoss?(taskId: string, kind: CheckJournalKind, reason: string): void;
  /** Где завести временные каталоги прогонов (`<core home>/tmp/checks`), снимаются после (P40). */
  tempRoot: string;
  now(): number;
  newId(): string;
  /** Карантин хранилища (G4): красный только карантинных тестов назван в заголовке повтора. */
  quarantine?(req: CheckRequest): Fact<QuarantineEntry[]>;
  writeQuarantine?(req: CheckRequest, entries: QuarantineEntry[]): void;
  /** Невыполненные условия, которые уже видит вызывающий (диск, сервисы) — в одно решение (P03). */
  blockers?(req: CheckRequest): Promise<Unmet[]>;
  /** Остановка извне (пауза, отмена задачи) для прогона ядра. */
  signal?(req: CheckRequest): AbortSignal | undefined;
  /** Подмена прогона — только для тестов дорог; по умолчанию `runCheck`. */
  run?(spec: RunSpec, lease: RunLease, deps: RunDeps): Promise<RunResult>;
  /** Как часто ждущий перечитывает очередь и ключ «в полёте» (мс). */
  pollMs?: number;
  /** Сколько ждать решения, прежде чем ответить `running` (P68: повторный вызов присоединяется). */
  answerBudgetMs?: number;
}

/** Исход прогона, который исполнил вызывающий (дороги захвата, `exec: 'caller'`, 03:124). */
export interface CallerResult {
  exit: number | null;
  ms: number;
  log: string;
  signal?: string | null;
  /** Обёртка вызывающего срезала вывод по своему потолку. */
  truncated?: boolean;
}

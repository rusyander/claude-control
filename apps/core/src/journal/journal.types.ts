import type { JournalDataV1, JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import type { Liveness } from '../platform/exclusive-lock.ts';

/**
 * Вход записи в журнал (P09): вида, автора и данных достаточно; `v`, `seq`, `at`, `mono`,
 * `bootId`, `taskId` здесь НЕТ — их ставит только `append`. Лишнее поле ловит и тип (литерал
 * объекта), и строгая проверка входа во время работы.
 */
export interface AppendInput<K extends JournalKind = JournalKind> {
  kind: K;
  actor: string;
  data: JournalDataV1[K];
  unitId?: string;
  stepId?: string;
  sessionId?: string;
  cmdId?: string;
  cause?: number;
}

/**
 * Маска секретов на входе (01 §Durability, P61): DLP ядра приходит снаружи (пакет
 * `@agentdeck/dlp`, агент A) — журнал знает только форму функции.
 */
export type MaskFn = (text: string) => { text: string; count: number };

export const NO_MASK: MaskFn = (text) => ({ text, count: 0 });

/** Часы, нужные журналу: штамп события и id загрузки. */
export interface JournalClock {
  readonly bootId: string;
  stamp(): { at: number; mono: number };
}

/** Кто я — для аренды задачи (01 §Lease). */
export interface CoreIdentity {
  build: string;
  pid: number;
  pidStart: string;
  bootId: string;
}

/** Жив ли процесс по pid + старту — интерфейс `LivenessProbe.isAlive` платформы C. */
export type IsAlive = (id: { pid: number; start: string }) => Promise<Liveness>;

export type { JournalLine, JournalKind };

export const TASK_FILES = {
  journal: 'journal.jsonl',
  snapshot: 'snapshot.json',
  artifacts: 'artifacts',
  owner: 'owner.json',
  beats: 'beats.log',
  rejected: 'journal.rejected.jsonl',
} as const;

export class JournalInputError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`journal input rejected: ${issues.join('; ')}`);
    this.name = 'JournalInputError';
    this.issues = issues;
  }
}

export class LeaseLostError extends Error {
  constructor(taskId: string) {
    super(`lease lost for task ${taskId}: another core owns the journal`);
    this.name = 'LeaseLostError';
  }
}

/**
 * Запись не подтверждена диском (ревью M5). `line` есть — строка уже в файле (упал fsync): живое
 * состояние обязано её учесть, иначе разойдётся с перемоткой; после этого писатель закрыт для
 * записей (fsync, упавший однажды, не доказывает и прежних страниц — урок fsyncgate), задачу
 * переоткрывают. `line` нет — запись откатана целиком, файл как до неё.
 */
export class JournalDurabilityError extends Error {
  readonly line: JournalLine | undefined;
  constructor(taskId: string, line: JournalLine | undefined, cause: unknown) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(`journal write not durable for task ${taskId}: ${why}`, { cause });
    this.name = 'JournalDurabilityError';
    this.line = line;
  }
}

export class JournalCorruptError extends Error {
  readonly seq: number;
  constructor(seq: number, reason: string) {
    super(`journal corrupt at line ${seq}: ${reason}`);
    this.name = 'JournalCorruptError';
    this.seq = seq;
  }
}

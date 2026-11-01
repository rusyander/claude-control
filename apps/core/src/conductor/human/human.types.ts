import type { HumanAskSource } from '@agentdeck/contracts/core/journal';
import type { AskState } from '@agentdeck/contracts/core/states';
import type { HumanPointRaise } from '../run/run.types.ts';
import type { HumanPointPolicy, NamedPoint } from '../../policy/human-point/human-point.types.ts';

/**
 * Подъём вопроса (G15). Шире `HumanPointRaise` шва ровно на пункты судьи права (3, 5): отказ права
 * называет пункт сам, и второй суд над тем же действием дал бы второе мнение (P80).
 */
export type RaiseInput = Omit<HumanPointRaise, 'point'> & { point: NamedPoint | null };

export interface RaiseDeps {
  policy: HumanPointPolicy;
}

export type RaiseOutcome =
  /** Вопрос задан: `waiting` — шаг ушёл в `waiting-human`. */
  | {
      kind: 'asked';
      askId: string;
      point: number;
      blocking: boolean;
      waiting: boolean;
      decisionSeq: number;
    }
  /** Тот же ключ у открытого вопроса — второго нет, ответ ссылается на первый (P130). */
  | { kind: 'duplicate'; askId: string; point: number; blocking: boolean }
  /** Вне списка: шаг идёт с рекомендацией, развилка — в итоговый отчёт (P20, P96). */
  | { kind: 'fork'; proceedWith: string; reason: string; decisionSeq: number }
  /** Источник назвал чужой пункт: вопроса нет, причина в журнале. */
  | { kind: 'refused'; reason: string; decisionSeq: number };

/** Вопрос человеку, как его видит журнал: всё, что нужно ответу, напоминанию и отчёту. */
export interface AskEntry {
  askId: string;
  point: number;
  source: HumanAskSource;
  dedupe: string | null;
  stepId: string | null;
  sessionId: string | null;
  question: string;
  options: string[];
  /** `null` — вопрос блокирующий (подъём пишет умолчание только неблокирующему). */
  defaultAction: string | null;
  blocking: boolean;
  askedAt: number;
  askedSeq: number;
  state: AskState;
  reminders: number;
  lastReminderAt: number | null;
  /** `cmdId` — команда ответа: по нему доставка ровно раз (F26). */
  answers: { text: string; seq: number; late: boolean; channel: string; cmdId: string | null }[];
}

export interface MessageEntry {
  cmdId: string;
  stepId: string;
  text: string;
  seq: number;
}

export interface ForkEntry {
  stepId: string | null;
  source: 'step_done' | 'ask_human' | 'blocker' | 'core';
  question: string;
  options: string[];
  chosen: string;
  reason: string;
}

export interface StepEntry {
  unitId: string;
  stepKind: string;
  state: string;
  sessionIds: string[];
  /** Основание исхода (`step.ended.basis`): `derived` и `not-implemented` идут в отчёт. */
  basis: string | null;
  reason: string | null;
  /** Строка, которой шаг пришёл в конец машины; `null` — шаг ещё идёт. */
  endedSeq: number | null;
}

export interface UnitEntry {
  name: string;
  repoKey: string;
  branch: string;
  state: string;
}

/**
 * Проекция журнала для зоны человека: вопросы, ответы, сообщения, доставки, гранты, развилки.
 * Свёртка ядра этих полей не держит (а держать текст ответов в каждом снимке — дорого), поэтому
 * здесь читается сам журнал — он истина (01 §State), память процесса после краха пуста.
 */
export interface HumanLedger {
  asks: Record<string, AskEntry>;
  messages: Record<string, MessageEntry>;
  /** По id ссылки (cmdId сообщения, askId ответа): доставлено ровно раз (F26). */
  deliveries: Record<string, { stepId: string; seq: number }>;
  grants: { cmdId: string; project: string; globs: string[]; ops: ('edit' | 'exec-db')[] }[];
  forks: ForkEntry[];
  steps: Record<string, StepEntry>;
  units: Record<string, UnitEntry>;
  requirements: Record<
    string,
    { ordinal: number; text: string; verdict: string; evidence: string[] }
  >;
  resources: Record<
    string,
    {
      kind: string;
      unitId: string | null;
      stepId: string | null;
      owner: 'core' | 'session';
      release: 'step-end' | 'unit-end' | 'task-end' | { keep: string };
      status: 'live' | 'released' | 'verified' | 'leak';
      ref: string;
    }
  >;
  externalEdits: { unitId: string; files: string[]; seq: number }[];
  signals: { signal: string; severity: string; subject: string; detail: string; seq: number }[];
  /** Умолчания ядра без модели (G7/G8), по одному на класс и основание. */
  coreDefaults: { class: string; basis: string; reason: string; stepId: string | null }[];
  /** Точки, на которых `report.final` уже записан: отчёт пишется раз на точку. */
  reports: string[];
}

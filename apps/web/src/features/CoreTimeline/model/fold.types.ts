import type { HumanAskSource } from '@agentdeck/contracts/core/journal';

/** Что показывает строка ленты: вид строки журнала, разобранный до полей, которые видит человек. */
export type RowItem =
  | { type: 'task-created'; title: string }
  | { type: 'step-started'; stepKind: string; stepDefId: string; round: number }
  | { type: 'step-ended'; outcome: 'done' | 'failed' | 'skipped'; reason: string }
  | { type: 'session-started'; cli: string }
  | {
      type: 'decision';
      decisionId: string;
      cls: string;
      outcome: string | null;
      reasons: string[];
    }
  | { type: 'check-requested'; checkRunId: string; checkId: string }
  | {
      type: 'signal';
      signal: string;
      severity: 'info' | 'warn' | 'stop';
      subject: string;
      detail: string;
      action: string | null;
    }
  | { type: 'asked'; askId: string; point: number; question: string }
  | { type: 'answered'; askId: string; answer: string; channel: string }
  | { type: 'budget'; scope: string; spent: number; limit: number | null }
  | { type: 'window'; routeId: string; verdict: string }
  | { type: 'report'; sha256: string }
  | { type: 'task-ended'; outcome: 'done' | 'cancelled' | 'failed' }
  | { type: 'command-rejected'; code: string; reason: string }
  | { type: 'error'; code: string; detail: string }
  | { type: 'in-artifact'; kind: string };

export interface TimelineRow {
  seq: number;
  at: number;
  kind: string;
  stepId: string | null;
  sessionId: string | null;
  item: RowItem;
}

/** Вопрос человеку, как его записал `human.asked`, плюс то, что карточке нужно для команды. */
export interface AskFact {
  askId: string;
  seq: number;
  point: number;
  source: HumanAskSource;
  question: string;
  options: string[];
  defaultAction: string | null;
  stepId: string | null;
  /** Деление, о котором вопрос запуска (ключ `split:<id>`), — для `approve-split`. */
  splitId: string | null;
  /** Цель отказа права, на которое поднят вопрос (`cause` → решение `permit`). */
  permit: { action: string; target: string } | null;
  /** Репозиторий единицы шага вопроса — проект гранта по умолчанию. */
  repoKey: string | null;
  answer: { text: string; channel: string } | null;
}

export interface TimelineFold {
  /** Последний свёрнутый номер: строка с номером не больше — повтор потока, она не дублируется. */
  lastSeq: number;
  rows: TimelineRow[];
  /** Строки без показа (телеметрия, служебные переходы) — только счёт. */
  hidden: number;
  asks: Record<string, AskFact>;
  /** seq решения `permit` → его цель: вопрос права ссылается на него `cause`. */
  permits: Record<number, { action: string; target: string }>;
  units: Record<string, { repoKey: string }>;
  stepUnits: Record<string, string>;
}

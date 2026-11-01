import { decisionOutcome } from '@agentdeck/contracts/core/decision-view';
import type { HumanAskSource } from '@agentdeck/contracts/core/journal';
import type { SseEvent } from '@entities/CoreTask';
import type { AskFact, RowItem, TimelineFold, TimelineRow } from './fold.types';

/**
 * Свёртка ленты для показа (этап 9, развилка F3): строки журнала из потока задачи → строки ленты
 * по времени. Это НЕ вторая свёртка ядра: числа расхода, состояния вопросов и проверки панель
 * берёт из `TaskView` (P43 — одна реализация), а здесь только то, что человек читает строкой:
 * заголовок решения, сигнал, вопрос, конец шага. Строка с номером, который уже свёрнут, — повтор
 * потока после обрыва без `Last-Event-ID` или двойной подписки: она отбрасывается, иначе лента
 * показала бы те же решения дважды.
 */

export const EMPTY_FOLD: TimelineFold = {
  lastSeq: 0,
  rows: [],
  hidden: 0,
  asks: {},
  permits: {},
  units: {},
  stepUnits: {},
};

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (o: Obj, k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '');
const strOrNull = (o: Obj, k: string): string | null =>
  typeof o[k] === 'string' ? (o[k] as string) : null;
const num = (o: Obj, k: string): number => (typeof o[k] === 'number' ? (o[k] as number) : 0);
const strings = (o: Obj, k: string): string[] =>
  Array.isArray(o[k]) ? (o[k] as unknown[]).filter((s): s is string => typeof s === 'string') : [];

interface Envelope {
  seq: number;
  at: number;
  kind: string;
  stepId: string | null;
  sessionId: string | null;
  cause: number | null;
  data: unknown;
}

/** Конверт строки из `data:` события; не JSON или без номера — не строка журнала, не свёртывается. */
export function parseLine(event: SseEvent): Envelope | null {
  let raw: unknown;
  try {
    raw = JSON.parse(event.data);
  } catch {
    return null;
  }
  if (!isObj(raw) || !Number.isInteger(raw.seq) || typeof raw.kind !== 'string') return null;
  return {
    seq: raw.seq as number,
    at: num(raw, 'at'),
    kind: raw.kind,
    stepId: strOrNull(raw, 'stepId'),
    sessionId: strOrNull(raw, 'sessionId'),
    cause: Number.isInteger(raw.cause) ? (raw.cause as number) : null,
    data: raw.data,
  };
}

const SEVERITIES = new Set(['info', 'warn', 'stop']);
const STEP_OUTCOMES = new Set(['done', 'failed', 'skipped']);
const TASK_OUTCOMES = new Set(['done', 'cancelled', 'failed']);

/** Строка → то, что показать; `null` — служебная строка (телеметрия, переходы машин), только счёт. */
function itemOf(line: Envelope, d: Obj): RowItem | null {
  switch (line.kind) {
    case 'task.created':
      return { type: 'task-created', title: str(d, 'title') };
    case 'step.started':
      return {
        type: 'step-started',
        stepKind: str(d, 'stepKind'),
        stepDefId: str(d, 'stepDefId'),
        round: num(d, 'round'),
      };
    case 'step.ended': {
      const outcome = str(d, 'outcome');
      if (!STEP_OUTCOMES.has(outcome)) return null;
      return {
        type: 'step-ended',
        outcome: outcome as 'done' | 'failed' | 'skipped',
        reason: str(d, 'reason'),
      };
    }
    case 'session.started':
      return { type: 'session-started', cli: str(d, 'adapter') };
    case 'decision': {
      const cls = str(d, 'class');
      return {
        type: 'decision',
        decisionId: str(d, 'decisionId'),
        cls,
        outcome: decisionOutcome(cls, d.output),
        reasons: strings(d, 'reasons'),
      };
    }
    case 'check.requested':
      return {
        type: 'check-requested',
        checkRunId: str(d, 'checkRunId'),
        checkId: str(d, 'checkId'),
      };
    case 'signal': {
      const severity = str(d, 'severity');
      return {
        type: 'signal',
        signal: str(d, 'signal'),
        severity: SEVERITIES.has(severity) ? (severity as 'info' | 'warn' | 'stop') : 'info',
        subject: str(d, 'subject'),
        detail: str(d, 'detail'),
        action: strOrNull(d, 'action'),
      };
    }
    case 'human.asked':
      return {
        type: 'asked',
        askId: str(d, 'askId'),
        point: num(d, 'point'),
        question: str(d, 'question'),
      };
    case 'human.answered':
      return {
        type: 'answered',
        askId: str(d, 'askId'),
        answer: str(d, 'answer'),
        channel: str(d, 'channel'),
      };
    case 'budget.state':
      return {
        type: 'budget',
        scope: str(d, 'scope'),
        spent: num(d, 'spent'),
        limit: typeof d.limit === 'number' ? d.limit : null,
      };
    case 'window.state':
      return { type: 'window', routeId: str(d, 'routeId'), verdict: str(d, 'verdict') };
    case 'report.final':
      return { type: 'report', sha256: isObj(d.report) ? str(d.report, 'sha256') : '' };
    case 'task.ended': {
      const outcome = str(d, 'outcome');
      if (!TASK_OUTCOMES.has(outcome)) return null;
      return { type: 'task-ended', outcome: outcome as 'done' | 'cancelled' | 'failed' };
    }
    case 'command.rejected':
      return { type: 'command-rejected', code: str(d, 'code'), reason: str(d, 'reason') };
    case 'error':
      return { type: 'error', code: str(d, 'code'), detail: str(d, 'detail') };
    default:
      return null;
  }
}

/** Виды, которые показываются строкой; их данные в артефакте — строка «данные артефактом». */
const SHOWN_KINDS = new Set([
  'task.created',
  'step.started',
  'step.ended',
  'session.started',
  'decision',
  'check.requested',
  'signal',
  'human.asked',
  'human.answered',
  'budget.state',
  'window.state',
  'report.final',
  'task.ended',
  'command.rejected',
  'error',
]);

/** Факты, на которые опираются карточки вопросов (цель права, единица шага, деление запуска). */
function noteFacts(fold: TimelineFold, line: Envelope, d: Obj): TimelineFold {
  switch (line.kind) {
    case 'unit.created':
      return {
        ...fold,
        units: { ...fold.units, [str(d, 'unitId')]: { repoKey: str(d, 'repoKey') } },
      };
    case 'step.started':
      return { ...fold, stepUnits: { ...fold.stepUnits, [str(d, 'stepId')]: str(d, 'unitId') } };
    case 'decision': {
      if (str(d, 'class') !== 'permit' || !isObj(d.output)) return fold;
      const permit = { action: str(d.output, 'action'), target: str(d.output, 'target') };
      return { ...fold, permits: { ...fold.permits, [line.seq]: permit } };
    }
    case 'human.asked': {
      const askId = str(d, 'askId');
      const stepId = strOrNull(d, 'stepId') ?? line.stepId;
      const dedupe = str(d, 'dedupe');
      const unitId = stepId ? fold.stepUnits[stepId] : undefined;
      const ask: AskFact = {
        askId,
        seq: line.seq,
        point: num(d, 'point'),
        source: str(d, 'source') as HumanAskSource,
        question: str(d, 'question'),
        options: strings(d, 'options'),
        defaultAction: strOrNull(d, 'defaultAction'),
        stepId,
        splitId: dedupe.startsWith('split:') ? dedupe.slice('split:'.length) : null,
        permit: line.cause !== null ? (fold.permits[line.cause] ?? null) : null,
        repoKey: unitId ? (fold.units[unitId]?.repoKey ?? null) : null,
        answer: null,
      };
      return { ...fold, asks: { ...fold.asks, [askId]: ask } };
    }
    case 'human.answered': {
      const ask = fold.asks[str(d, 'askId')];
      if (!ask) return fold;
      const answer = { text: str(d, 'answer'), channel: str(d, 'channel') };
      return { ...fold, asks: { ...fold.asks, [ask.askId]: { ...ask, answer } } };
    }
    default:
      return fold;
  }
}

/** Одна строка потока в свёртку; повтор номера и не-строка возвращают ту же свёртку. */
export function foldEvent(fold: TimelineFold, event: SseEvent): TimelineFold {
  const line = parseLine(event);
  if (!line || line.seq <= fold.lastSeq) return fold;
  const d = isObj(line.data) ? line.data : null;
  const base = { ...fold, lastSeq: line.seq };
  if (!d) {
    // Данные строки вынесены артефактом (`dataRef`, `data: null`): показываемый вид — честная
    // строка «данные артефактом», а не пустой заголовок.
    if (!SHOWN_KINDS.has(line.kind)) return { ...base, hidden: base.hidden + 1 };
    return { ...base, rows: [...base.rows, rowOf(line, { type: 'in-artifact', kind: line.kind })] };
  }
  const noted = noteFacts(base, line, d);
  const item = itemOf(line, d);
  if (!item) return { ...noted, hidden: noted.hidden + 1 };
  return { ...noted, rows: [...noted.rows, rowOf(line, item)] };
}

function rowOf(line: Envelope, item: RowItem): TimelineRow {
  return {
    seq: line.seq,
    at: line.at,
    kind: line.kind,
    stepId: line.stepId,
    sessionId: line.sessionId,
    item,
  };
}

export function foldEvents(events: readonly SseEvent[], from: TimelineFold = EMPTY_FOLD) {
  return events.reduce(foldEvent, from);
}

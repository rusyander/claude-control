import type { JournalDataV1, JournalLine } from '@agentdeck/contracts/core/journal';
import type { TaskFoldStage5, TaskFoldState, UsageTotals } from './reduce.types.ts';

/**
 * Свёртка видов журнала этапа 5 (план s5 §1, свёртка v7): расход хода, окно маршрута, бюджеты,
 * отданные секции вводной, замеры базового контекста. Чистая, как `reduce`: противоречие —
 * аномалия, запись не трогается. `undefined` — вид не этого модуля.
 */

type Anomaly = (reason: string) => TaskFoldState;
type TurnUsage = JournalDataV1['turn.usage'];

export const ZERO_USAGE: UsageTotals = {
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  output: 0,
  turns: 0,
};

export function initialStage5(): TaskFoldStage5 {
  return {
    usage: {
      task: ZERO_USAGE,
      bySession: {},
      byStep: {},
      subagents: ZERO_USAGE,
      lastByMessage: {},
    },
    windows: {},
    budgets: {},
    sent: {},
    bases: [],
    routesSet: null,
  };
}

function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Ключ строки расхода: messageId уникален только в разговоре одной сессии. */
export function usageKey(sessionId: string, messageId: string): string {
  return `${sessionId}|${messageId}`;
}

/** Ключ окна: вердикт держит пару «маршрут × вид предела», не маршрут целиком (11 §Economy). */
export function windowKey(routeId: string, limitKind: string): string {
  return `${routeId}|${limitKind}`;
}

/** Вклад строки в итоги: ход считается только у строки модели, остаток ходом не является. */
function contribution(row: TurnUsage | undefined): UsageTotals {
  if (!row) return ZERO_USAGE;
  return {
    input: row.input,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    cacheWrite1h: row.cacheWrite1h,
    output: row.output,
    turns: row.remainder ? 0 : 1,
  };
}

/** `total − was + now`: строка с тем же ключом ЗАМЕНЯЕТ свой прежний вклад (P43, без удвоения). */
function swap(total: UsageTotals, was: UsageTotals, now: UsageTotals): UsageTotals {
  return {
    input: total.input - was.input + now.input,
    cacheRead: total.cacheRead - was.cacheRead + now.cacheRead,
    cacheWrite: total.cacheWrite - was.cacheWrite + now.cacheWrite,
    cacheWrite1h: total.cacheWrite1h - was.cacheWrite1h + now.cacheWrite1h,
    output: total.output - was.output + now.output,
    turns: total.turns - was.turns + now.turns,
  };
}

function swapIn(
  map: Record<string, UsageTotals>,
  key: string,
  was: UsageTotals,
  now: UsageTotals,
): Record<string, UsageTotals> {
  return { ...map, [key]: swap(own(map, key) ?? ZERO_USAGE, was, now) };
}

/**
 * Расход хода. Подагент своей сессии ядра не имеет: его строка идёт в сессию-родителя (и в её
 * шаг) и отдельно в `subagents` — вид расхода показывает подагентов, не удваивая итог (F24).
 */
function foldUsage(next: TaskFoldState, row: TurnUsage, anomaly: Anomaly): TaskFoldState {
  const owner = row.subagent && row.parentSessionId ? row.parentSessionId : row.sessionId;
  const session = own(next.sessions, owner);
  if (!session) return anomaly(`turn.usage: unknown session ${owner}`);
  const key = usageKey(row.sessionId, row.messageId);
  const prior = own(next.usage.lastByMessage, key);
  // Строка того же хода может сменить сессию-владельца только противоречием журнала.
  if (prior && (prior.subagent !== row.subagent || prior.parentSessionId !== row.parentSessionId))
    return anomaly(`turn.usage: ${row.messageId} changed its owner`);
  const was = contribution(prior);
  const now = contribution(row);
  const usage = next.usage;
  return {
    ...next,
    usage: {
      task: swap(usage.task, was, now),
      bySession: swapIn(usage.bySession, owner, was, now),
      byStep: swapIn(usage.byStep, session.stepId, was, now),
      subagents: row.subagent ? swap(usage.subagents, was, now) : usage.subagents,
      lastByMessage: { ...usage.lastByMessage, [key]: row },
    },
  };
}

export function reduceStage5(
  next: TaskFoldState,
  line: JournalLine,
  anomaly: Anomaly,
): TaskFoldState | undefined {
  switch (line.kind) {
    case 'turn.usage':
      return foldUsage(next, (line as JournalLine<'turn.usage'>).data, anomaly);
    case 'window.state': {
      const d = (line as JournalLine<'window.state'>).data;
      const key = windowKey(d.routeId, d.limitKind);
      return { ...next, windows: { ...next.windows, [key]: { ...d, seq: line.seq } } };
    }
    case 'brief.sent': {
      // Порядок «вводная ↔ запуск сеанса» — дело проводки: набор помнится и без записи сеанса.
      const d = (line as JournalLine<'brief.sent'>).data;
      const had = own(next.sent, d.sessionId) ?? {};
      const add = Object.fromEntries(d.sections.map((s) => [s.id, s.sha256]));
      return { ...next, sent: { ...next.sent, [d.sessionId]: { ...had, ...add } } };
    }
    case 'context.base': {
      const d = (line as JournalLine<'context.base'>).data;
      return { ...next, bases: [...next.bases, d] };
    }
    case 'routes.set': {
      if (!next.created) return anomaly('routes.set before task.created');
      const d = (line as JournalLine<'routes.set'>).data;
      return { ...next, routesSet: { ...d, seq: line.seq } };
    }
    default:
      return undefined;
  }
}

/** `budget.state` любой области помнится последним значением; срок шага ведёт `stage4.ts`. */
export function recordBudget(
  next: TaskFoldState,
  line: JournalLine<'budget.state'>,
): TaskFoldState {
  const d = line.data;
  return { ...next, budgets: { ...next.budgets, [d.scope]: { ...d, seq: line.seq } } };
}

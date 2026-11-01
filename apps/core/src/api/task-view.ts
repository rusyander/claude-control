import type { Fact } from '@agentdeck/contracts/core/facts';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { RoutePrice } from '@agentdeck/contracts/core/routes';
import type {
  CheckView,
  CheckViewMode,
  CostView,
  ReportRef,
  ScenarioView,
  SessionView,
  SplitView,
  TaskView,
  UsageView,
} from '@agentdeck/contracts/core/task-view';
import { spendOf, turnsOfLines, type PriceTable } from '../economy/price/index.ts';
import type { TaskFoldState, UsageTotals } from '../journal/reduce/reduce.types.ts';

/**
 * Вид задачи для панели (этап 9, 07:18-22): свёртка + строки журнала → `TaskView`. Чистая
 * функция: цены маршрутов приходят готовым справочником (`priceBookOf`), чтобы один и тот же
 * журнал всегда давал одни и те же числа. Деньги считает ТОЛЬКО `spendOf` — та же функция, что
 * у экономики и у пересчёта P43; своей формулы здесь нет, иначе экран и решения ядра разошлись бы.
 */

export type PriceFor = (routeId: string, model: string) => Fact<RoutePrice>;

export interface TaskViewInput {
  taskId: string;
  state: TaskFoldState;
  lines: readonly JournalLine[];
  priceFor: PriceFor;
  attention: string | null;
  table?: PriceTable;
}

const MODES: ReadonlySet<string> = new Set<CheckViewMode>(['run', 'replay', 'narrow']);

const ZERO_USAGE: UsageView = {
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  output: 0,
  turns: 0,
};

const usage = (u: UsageTotals | undefined): UsageView => (u ? { ...u } : { ...ZERO_USAGE });

const costOf = (lines: readonly JournalLine[], priceFor: PriceFor, table?: PriceTable): CostView =>
  spendOf(turnsOfLines(lines), priceFor, table);

/**
 * Справочник цен для `spendOf`: каждая пара «маршрут × модель» из ходов журнала читается один
 * раз заранее (чтение маршрута асинхронное, `spendOf` — нет). Нет порта цен — `unknown` с
 * причиной: ходы остаются токенами без цены, а не деньгами по догадке (P127).
 */
export async function priceBookOf(
  lines: readonly JournalLine[],
  routePrice: ((routeId: string, model: string) => Promise<Fact<RoutePrice>>) | undefined,
): Promise<PriceFor> {
  const book = new Map<string, Fact<RoutePrice>>();
  for (const line of lines) {
    if (line.kind !== 'turn.usage') continue;
    const { routeId, model } = (line as JournalLine<'turn.usage'>).data;
    const key = `${routeId}|${model}`;
    if (book.has(key)) continue;
    book.set(key, { unknown: 'route prices not wired' });
    if (!routePrice) continue;
    try {
      book.set(key, await routePrice(routeId, model));
    } catch (error) {
      book.set(key, { unknown: error instanceof Error ? error.message : String(error) });
    }
  }
  return (routeId, model) =>
    book.get(`${routeId}|${model}`) ?? { unknown: `no price read for ${routeId}` };
}

function sessionsOf(state: TaskFoldState, lines: readonly JournalLine[]): SessionView[] {
  const started = new Map<string, JournalLine<'session.started'>>();
  for (const line of lines) {
    if (line.kind === 'session.started') {
      const typed = line as JournalLine<'session.started'>;
      started.set(typed.data.sessionId, typed);
    }
  }
  return Object.entries(state.sessions).map(([sessionId, s]) => {
    const line = started.get(sessionId);
    return {
      sessionId,
      stepId: s.stepId,
      state: s.state,
      cli: s.adapter,
      cliVersion: line && line.data.cliVersion !== '' ? line.data.cliVersion : null,
      route: s.route,
      modelAsked: s.modelAsked,
      modelServed: s.modelServed,
      // Усилие свёртка не держит — оно в строке начала сессии.
      effort: line?.data.effort ?? null,
      startedSeq: line?.seq ?? 0,
    };
  });
}

/**
 * Проверки ленты — решения класса `check` видов run / replay / narrow. Запись повтора названа
 * в самом решении; у прогона и сужения она появляется позже: первый `check.requested` того же
 * шага после решения (журнал пишет их подряд) и его `check.recorded`.
 */
export function checksOf(lines: readonly JournalLine[]): CheckView[] {
  const recorded = new Map<string, string>();
  for (const line of lines) {
    if (line.kind === 'check.recorded') {
      const d = (line as JournalLine<'check.recorded'>).data;
      recorded.set(d.checkRunId, d.recordId);
    }
  }
  const claimed = new Set<number>();
  const out: CheckView[] = [];
  lines.forEach((line, index) => {
    if (line.kind !== 'decision') return;
    const d = (line as JournalLine<'decision'>).data;
    if (d.class !== 'check' || typeof d.output !== 'object' || d.output === null) return;
    const output = d.output as Record<string, unknown>;
    const mode = output.kind;
    if (typeof mode !== 'string' || !MODES.has(mode)) return;
    const why =
      typeof output.reason === 'string'
        ? output.reason
        : typeof output.header === 'string'
          ? output.header
          : mode;
    let recordId: string | null = null;
    if (mode === 'replay') {
      recordId = typeof output.recordId === 'string' ? output.recordId : null;
    } else {
      for (let i = index + 1; i < lines.length; i += 1) {
        const next = lines[i]!;
        if (next.kind === 'decision' && (next as JournalLine<'decision'>).data.class === 'check')
          break;
        if (next.kind !== 'check.requested' || claimed.has(i)) continue;
        if ((next.stepId ?? null) !== (line.stepId ?? null)) continue;
        claimed.add(i);
        const run = (next as JournalLine<'check.requested'>).data.checkRunId;
        recordId = recorded.get(run) ?? null;
        break;
      }
    }
    out.push({
      decisionId: d.decisionId,
      seq: line.seq,
      stepId: line.stepId ?? null,
      mode: mode as CheckViewMode,
      why,
      recordId,
    });
  });
  return out;
}

export function reportOf(state: TaskFoldState, lines: readonly JournalLine[]): ReportRef | null {
  if (!state.report) return null;
  const line = lines.find((l) => l.seq === state.report!.seq && l.kind === 'report.final');
  if (!line) return null;
  const d = (line as JournalLine<'report.final'>).data;
  return { seq: line.seq, at: d.at, sha256: d.report.sha256, bytes: d.report.bytes };
}

export function taskViewOf(input: TaskViewInput): TaskView {
  const { state, lines, priceFor, table } = input;
  const turnLines = lines.filter((l) => l.kind === 'turn.usage') as JournalLine<'turn.usage'>[];
  const linesBySession = new Map<string, JournalLine[]>();
  for (const line of turnLines) {
    const sid = line.data.sessionId;
    linesBySession.set(sid, [...(linesBySession.get(sid) ?? []), line]);
  }
  const linesByStep = new Map<string, JournalLine[]>();
  for (const [sid, own] of linesBySession) {
    const stepId = state.sessions[sid]?.stepId;
    if (!stepId) continue;
    linesByStep.set(stepId, [...(linesByStep.get(stepId) ?? []), ...own]);
  }
  const bySession: TaskView['spend']['bySession'] = {};
  for (const [sid, own] of linesBySession) {
    bySession[sid] = {
      tokens: usage(state.usage.bySession[sid]),
      cost: costOf(own, priceFor, table),
    };
  }
  const byStep: TaskView['spend']['byStep'] = {};
  for (const [stepId, own] of linesByStep) {
    byStep[stepId] = {
      tokens: usage(state.usage.byStep[stepId]),
      cost: costOf(own, priceFor, table),
    };
  }
  return {
    taskId: input.taskId,
    seq: state.seq,
    state: state.task,
    ended: state.ended,
    steps: Object.entries(state.steps)
      .map(([stepId, s]) => ({
        stepId,
        unitId: s.unitId,
        stepKind: s.stepKind,
        stepDefId: s.stepDefId,
        round: s.round,
        state: s.state,
        startedSeq: s.startedSeq,
        budgetMs: s.budgetMs,
        outcome: s.outcome ?? null,
        reason: s.reason ?? null,
      }))
      .sort((a, b) => a.startedSeq - b.startedSeq),
    sessions: sessionsOf(state, lines).sort((a, b) => a.startedSeq - b.startedSeq),
    checks: checksOf(lines),
    asks: Object.entries(state.asks).map(([askId, a]) => ({
      askId,
      state: a.state,
      point: a.point,
      source: a.source,
      stepId: a.stepId,
      lateAnswer: a.lateAnswer,
      answer: a.answer ?? null,
    })),
    budgets: Object.values(state.budgets).map((b) => ({
      scope: b.scope,
      spent: b.spent,
      limit: b.limit,
      seq: b.seq,
    })),
    windows: Object.values(state.windows).map((w) => ({
      routeId: w.routeId,
      limitKind: w.limitKind,
      verdict: w.verdict,
      resetAt: w.resetAt,
      seq: w.seq,
    })),
    spend: {
      tokens: usage(state.usage.task),
      cost: costOf(turnLines, priceFor, table),
      bySession,
      byStep,
    },
    report: reportOf(state, lines),
    scenario: scenarioOf(state),
    split: splitOf(state, lines),
    attention: input.attention,
  };
}

/**
 * Сценарий задачи и ждущая смена (G7): экран сценариев показывает правку идущей задачи по виду, а
 * не по своей свёртке потока. Счётчик отказов свёртки — внутренний, в вид не идёт.
 */
export function scenarioOf(state: TaskFoldState): ScenarioView | null {
  if (!state.scenario) return null;
  return { ref: state.scenario.ref, pending: state.scenario.pending };
}

/**
 * Последнее предложенное деление: единицы живут только в строке `split.proposed`, решение — в
 * свёртке (`splits[id].state`). Строки нет в хвосте журнала — деления для вида нет.
 */
export function splitOf(state: TaskFoldState, lines: readonly JournalLine[]): SplitView | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line?.kind !== 'split.proposed') continue;
    const d = (line as JournalLine<'split.proposed'>).data;
    return {
      splitId: d.splitId,
      seq: line.seq,
      by: d.by,
      state: state.splits[d.splitId]?.state ?? 'proposed',
      units: d.units,
    };
  }
  return null;
}

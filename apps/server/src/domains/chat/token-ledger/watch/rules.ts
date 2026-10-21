import { GROUP_WATCH_SEVERITY, type GroupWatchRule } from '@agentdeck/contracts/group-watch';
import { modelFactor, write1hPart } from '../../../analytics/token-audit/window-weight.ts';
import type { RuleHit, WatchContext, WatchNode, WatchState } from './watch.types.ts';

/**
 * Правила сторожа R1–R12 (`group-autonomy-plan` §A). Каждое — чистая функция
 * состояния, звена, порогов и «сейчас»: попадание или ничего. Правило-событие
 * (холодная запись, спавн ревью, коммит…) держится полчаса после повода и само
 * закрывается — иначе однажды случившееся висело бы до конца группы.
 */

/** Сколько правило-событие остаётся активным после последнего повода. */
export const EVENT_HOLD_MS = 30 * 60_000;
/** Срок вызова, если он сам его не назвал (Bash по умолчанию — 2 минуты). */
const DEFAULT_TOOL_MS = 2 * 60_000;
/**
 * Субагент шлёт свои события, и его молчание законно, но не бесконечно:
 * дольше двух порогов тишины — зависание, даже если вызов ещё открыт.
 */
const SPAWN_TOOLS = new Set(['Task', 'Agent']);
const SPAWN_STALL_FACTOR = 2;
const REVIEW_SPAWN = /deep-review|^\s*review:/i;
const STAGES_WITHOUT_WRITES = new Set(['work', 'review']);

const minutes = (ms: number): number => Math.round(ms / 60_000);
const clip = (text: string, max = 160): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

type Rule = (
  state: WatchState,
  node: WatchNode,
  ctx: WatchContext,
  now: number,
) => Omit<RuleHit, 'rule' | 'severity'> | undefined;

/** Свежие поводы правила-события. */
const recent = <T extends { at: number }>(list: readonly T[], now: number): T[] =>
  list.filter((item) => now - item.at <= EVENT_HOLD_MS);

/** Открытый вызов ещё в своём сроке — молчание законно. */
function waitingOnTool(state: WatchState, now: number, stallMs: number): boolean {
  const idle = now - state.lastEventAt;
  return Object.values(state.openTools).some((tool) =>
    SPAWN_TOOLS.has(tool.name)
      ? idle <= stallMs * SPAWN_STALL_FACTOR
      : !tool.background && tool.startedAt + (tool.timeoutMs ?? DEFAULT_TOOL_MS) > now,
  );
}

function openAsk(
  state: WatchState,
  node: WatchNode,
): { since: number; question?: string } | undefined {
  if (node.ask) return node.ask;
  const tool = Object.values(state.openTools).find((open) => open.name === 'AskUserQuestion');
  return tool
    ? { since: tool.startedAt, ...(tool.question ? { question: tool.question } : {}) }
    : undefined;
}

const RULES: Record<GroupWatchRule, Rule> = {
  R1(state, node, ctx, now) {
    if (!node.running || node.paused || node.heavyLease || openAsk(state, node)) return undefined;
    const stallMs = ctx.settings.stallMinutes * 60_000;
    if (state.endedAt !== undefined || waitingOnTool(state, now, stallMs)) return undefined;
    const idle = now - state.lastEventAt;
    if (idle <= stallMs) return undefined;
    return { numbers: { idleMin: minutes(idle) }, since: state.lastEventAt };
  },

  R1b(state, node, ctx, now) {
    const ask = openAsk(state, node);
    if (!ask) return undefined;
    const waited = now - ask.since;
    if (waited <= ctx.settings.askMinutes * 60_000) return undefined;
    return {
      numbers: { waitMin: minutes(waited) },
      ...(ask.question ? { params: { question: clip(ask.question, 200) } } : {}),
      since: ask.since,
    };
  },

  R2(state, _node, _ctx, now) {
    const cold = recent(state.coldWrites, now).at(-1);
    if (!cold) return undefined;
    const model = state.calls.findLast((call) => !call.sidechain)?.model;
    // Перезапись окна по цене записи (часовой кэш ×2, пятиминутный ×1.25) вместо чтения (×0.1): потеря в W.
    const write1h = write1hPart(cold.write, cold.write1h);
    const lostTokens = write1h * (2 - 0.1) + (cold.write - write1h) * (1.25 - 0.1);
    const lost = (modelFactor(model) * lostTokens) / 1e6;
    return {
      numbers: {
        writeK: Math.round(cold.write / 1000),
        gapMin: minutes(cold.gapMs),
        lostW: Math.round(lost * 100) / 100,
      },
      since: cold.at,
    };
  },

  R3(state, _node, ctx, now) {
    const [before, last] = state.compactions.slice(-2);
    if (before === undefined || last === undefined || now - last > EVENT_HOLD_MS) return undefined;
    const gap = last - before;
    if (gap >= ctx.settings.compactMinutes * 60_000) return undefined;
    const lastHour = state.compactions.filter((t) => now - t <= 60 * 60_000).length;
    return { numbers: { gapMin: minutes(gap), count: lastHour }, since: last };
  },

  R4(state, _node, ctx) {
    const worst = Object.values(state.checks).sort((a, b) => b.runs - a.runs)[0];
    if (!worst || worst.runs < ctx.settings.checkRepeats) return undefined;
    return {
      numbers: { runs: worst.runs },
      params: { command: clip(worst.command) },
      since: worst.lastAt,
    };
  },

  R5(state, _node, _ctx, now) {
    const spawns = recent(state.subagents, now).filter(
      (spawn) =>
        spawn.stage === 'work' &&
        (REVIEW_SPAWN.test(spawn.description) || /deep-review/i.test(spawn.agentType)),
    );
    const last = spawns.at(-1);
    if (!last) return undefined;
    return {
      numbers: { spawns: spawns.length },
      params: { description: clip(last.description, 80) },
      since: last.at,
    };
  },

  R6(state, node, _ctx, now) {
    // Звена доставки впереди нет — пуш и MR и есть работа этого звена.
    if (!node.deliverAhead) return undefined;
    const ops = recent(state.writeOps, now).filter(
      (op) => op.stage !== undefined && STAGES_WITHOUT_WRITES.has(op.stage),
    );
    const last = ops.at(-1);
    if (!last) return undefined;
    return {
      numbers: { ops: ops.length },
      params: { op: last.op, stage: last.stage ?? '' },
      since: last.at,
    };
  },

  R7(state, _node, _ctx, now) {
    const reads = recent(state.panelReads, now);
    const last = reads.at(-1);
    if (!last) return undefined;
    return {
      numbers: { reads: reads.length },
      params: { path: clip(last.path, 120) },
      since: last.at,
    };
  },

  R8(state, _node, ctx, now) {
    const span = ctx.settings.burnMinutes * 60_000;
    const window = state.calls.filter((call) => now - call.t <= span);
    // Один тяжёлый вызов — не «жжёт»: нужен поток.
    if (window.length < 3) return undefined;
    const weight = window.reduce((sum, call) => sum + call.weight, 0);
    const perHour = (weight * 60) / ctx.settings.burnMinutes;
    if (perHour <= ctx.settings.burnPerHour) return undefined;
    return { numbers: { perHour: Math.round(perHour * 10) / 10 }, since: window[0]?.t ?? now };
  },

  R9(state, _node, ctx, now) {
    const latest = state.limits.at(-1);
    if (!latest) return undefined;
    const from = now - ctx.settings.projectionMinutes * 60_000;
    const points = state.limits.filter(
      (point) => point.t >= from && point.resetsAt === latest.resetsAt,
    );
    const first = points[0];
    if (!first || latest.t - first.t < 5 * 60_000) return undefined;
    const slope = (latest.utilization - first.utilization) / (latest.t - first.t);
    if (slope <= 0) return undefined;
    const resetMs = latest.resetsAt * 1000;
    const projected = latest.utilization + slope * Math.max(0, resetMs - latest.t);
    if (projected * 100 <= ctx.settings.projectionPercent) return undefined;
    return {
      numbers: {
        projectedPct: Math.round(projected * 100),
        nowPct: Math.round(latest.utilization * 100),
        resetMin: Math.max(0, minutes(resetMs - now)),
      },
      since: first.t,
    };
  },

  R10(state, _node, _ctx, now) {
    if (state.rejectedAt === undefined) return undefined;
    const resetMs = (state.rejectedResetsAt ?? 0) * 1000;
    return {
      numbers: { resetMin: resetMs > now ? minutes(resetMs - now) : 0 },
      since: state.rejectedAt,
    };
  },

  R11(state, _node, _ctx, now) {
    const polls = recent(state.sleepPolls, now);
    const last = polls.at(-1);
    if (!last) return undefined;
    return {
      numbers: { polls: polls.length },
      params: { command: clip(last.command) },
      since: last.at,
    };
  },

  R12(state, _node, ctx) {
    const [key, worst] =
      Object.entries(state.reads).sort((a, b) => b[1].count - a[1].count)[0] ?? [];
    if (!key || !worst || worst.count < ctx.settings.rereadRepeats) return undefined;
    return {
      numbers: { reads: worst.count },
      params: { path: clip(key.split('#')[0] ?? key, 120) },
      since: worst.lastAt,
    };
  },
};

/** Все правила по состоянию сессии: список попаданий (пустой — всё спокойно). */
export function evaluate(
  state: WatchState,
  node: WatchNode,
  ctx: WatchContext,
  now: number,
): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const [rule, check] of Object.entries(RULES) as Array<[GroupWatchRule, Rule]>) {
    const hit = check(state, node, ctx, now);
    if (hit) hits.push({ rule, severity: GROUP_WATCH_SEVERITY[rule], ...hit });
  }
  return hits;
}

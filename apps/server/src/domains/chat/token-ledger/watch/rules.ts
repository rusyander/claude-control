import {
  GROUP_WATCH_RULES,
  GROUP_WATCH_SEVERITY,
  type GroupWatch,
  type GroupWatchRule,
} from '@agentdeck/contracts/group-watch';
import { modelFactor, write1hPart } from '../../../analytics/token-audit/window-weight.ts';
import { INCIDENT_RULES } from './rules-incidents.ts';
import { orphanPorts, R34 } from './rules-autonomy.ts';
import {
  clip,
  EVENT_HOLD_MS,
  MINUTE_MS,
  minutes,
  openAsk,
  recent,
  type Rule,
} from './rules-util.ts';
import type {
  HeavyCheck,
  RuleHit,
  WatchContext,
  WatchNode,
  WatchScope,
  WatchState,
} from './watch.types.ts';

/**
 * Правила сторожа R1–R12 (`group-autonomy-plan` §A) и R13–R19 — утечки W и
 * задержки, снятые с прогонов групп (веер субагентов, огромный ответ, упор в
 * срок, долгий вызов, ожидание очереди, стена стражей, тяжёлый первый запрос).
 * Каждое — чистая функция состояния, звена, порогов и «сейчас»: попадание или
 * ничего. Правило-событие (холодная запись, спавн ревью, коммит…) держится
 * полчаса после повода и само закрывается — иначе однажды случившееся висело бы
 * до конца группы.
 */

export { EVENT_HOLD_MS } from './rules-util.ts';
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

/** Открытый вызов ещё в своём сроке — молчание законно. */
function waitingOnTool(state: WatchState, now: number, stallMs: number): boolean {
  const idle = now - state.lastEventAt;
  return Object.values(state.openTools).some((tool) =>
    SPAWN_TOOLS.has(tool.name)
      ? idle <= stallMs * SPAWN_STALL_FACTOR
      : !tool.background && tool.startedAt + (tool.timeoutMs ?? DEFAULT_TOOL_MS) > now,
  );
}

/**
 * Правила группы и плана, не одной сессии: R22 — группа стоит без хода, R23 — одна
 * беда в нескольких группах плана, R28 — напоминания о доставке не двигают её.
 * Их тела — у сторожа (полоса L2): здесь они только объявлены.
 */
export const GROUP_LEVEL: ReadonlySet<GroupWatchRule> = new Set(['R22', 'R23', 'R28']);

/**
 * Правила не одной сессии: R8 — расход всей группы (звенья, ревью, доставка,
 * субагенты), R9 — прогноз окна всего аккаунта, R21 — тяжёлые проверки всех
 * разговоров группы, и правила группы (`GROUP_LEVEL`). Их считает сторож по своим
 * спискам (`groupBurn`, `accountProjection`, `groupGates`), а сигнал у них один на группу.
 */
export const GROUP_SCOPED_RULES: ReadonlySet<GroupWatchRule> = new Set([
  'R8',
  'R9',
  'R21',
  'R35',
  ...GROUP_LEVEL,
]);

/**
 * Правила одиночного чата панели (`WatchScope` `chat`). Нет: R1b (вопросы
 * отслеживаются только у дерева чатов), R5–R7 (стадии и копия), R8/R9 (расход
 * группы и аккаунта считаются в одном месте), R20 (пауза группы), R21 (тяжёлые проверки
 * считает сторож по списку группы — у одиночного чата его нет, F-78), R22/R23/R28/R31/R33
 * (группа, план, своя копия, стадия ревью), R34–R36 (новый разговор группы, коммиты
 * её стадии, пауза группы).
 */
export const SINGLE_RULES: ReadonlySet<GroupWatchRule> = new Set([
  'R1',
  'R2',
  'R3',
  'R4',
  'R10',
  'R11',
  'R12',
  'R13',
  'R14',
  'R15',
  'R16',
  'R17',
  'R18',
  'R19',
  'R24',
  'R25',
  'R26',
  'R27',
  'R29',
  'R30',
  'R32',
]);
/** Правила сессии — `evaluate` по её состоянию. */
export const SESSION_RULES: ReadonlySet<GroupWatchRule> = new Set(
  GROUP_WATCH_RULES.filter((rule) => !GROUP_SCOPED_RULES.has(rule)),
);

/**
 * Последние секунды хода до остановки — не утечка: пауза гасит процесс не мгновенно,
 * и вызов, начатый в ту же минуту, ещё доходит до транскрипта.
 */
const PAUSE_GRACE_MS = 60_000;

/**
 * R20 — группа действует на паузе. Человек остановил её, а фоновая задача или
 * запоздалое уведомление разбудили CLI: 23.10 через 4 минуты после паузы сессия
 * закоммитила, завела worktree и подняла карточку прав. Тревога: пауза не держит.
 */
function pausedActivity(state: WatchState, node: WatchNode): RuleHit | undefined {
  const pausedAt = node.pausedAt;
  if (!node.paused || pausedAt === undefined) return undefined;
  const after = state.actions.filter((action) => action.at > pausedAt + PAUSE_GRACE_MS);
  const tools = after.filter((action) => !action.start).length;
  const first = after[0];
  if (!first || tools === 0) return undefined;
  return {
    rule: 'R20',
    severity: GROUP_WATCH_SEVERITY.R20,
    numbers: { tools, afterMin: minutes(first.at - pausedAt) },
    ...(state.lastActionLabel ? { params: { call: clip(state.lastActionLabel) } } : {}),
    since: first.at,
  };
}

const RULES: Record<
  Exclude<GroupWatchRule, 'R8' | 'R9' | 'R20' | 'R21' | 'R22' | 'R23' | 'R28' | 'R35' | 'R36'>,
  Rule
> = {
  ...INCIDENT_RULES,
  R34,

  R1(state, node, ctx, now) {
    // Ждёт места в очереди или держит аренду — идёт долгая проверка, не зависание (ожидание — R17).
    const queued = node.heavyLease === true || node.heavyWait !== undefined;
    if (!node.running || node.paused || queued || openAsk(state, node)) return undefined;
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
    if (waited <= ctx.settings.askMinutes * MINUTE_MS) return undefined;
    // Ночь у карточки (C02: 253 мин на «внимании», одно уведомление) — уже тревога.
    const alert = waited >= ctx.settings.askAlertMinutes * MINUTE_MS;
    return {
      ...(alert ? { severity: 'alert' as const } : {}),
      numbers: { waitMin: minutes(waited) },
      ...(ask.question ? { params: { question: clip(ask.question, 200) } } : {}),
      since: ask.since,
    };
  },

  R2(state, _node, _ctx, now) {
    const cold = recent(state.coldWrites, now).at(-1);
    if (!cold) return undefined;
    const model = state.calls.at(-1)?.model;
    // Перезапись окна по цене записи (часовой кэш ×2, пятиминутный ×1.25) вместо чтения (×0.1): потеря в W.
    // Чужой CLI: вход полной ценой (×1) вместо чтения кэша (×0.1, оценка: у провайдеров скидка своя).
    const write1h = write1hPart(cold.write, cold.write1h);
    const lostTokens = cold.uncached
      ? cold.write * (1 - 0.1)
      : write1h * (2 - 0.1) + (cold.write - write1h) * (1.25 - 0.1);
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
    // Ревью — и субагентом, и навыком (`/deep-review`).
    const spawns = recent(
      [...state.subagents, ...state.skills].sort((a, b) => a.at - b.at),
      now,
    ).filter(
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

  R13(state, _node, ctx, now) {
    const span = ctx.settings.fanoutMinutes * 60_000;
    const inSpan = (at: number): boolean => at <= now && now - at <= span;
    // Навык (`Skill`) — не субагент: своего окна и расхода у него нет, он в своём списке.
    const spawns = state.subagents.filter((spawn) => inSpan(spawn.at));
    const burn = state.subBurn.filter((point) => inSpan(point.at));
    const subW = burn.reduce((sum, point) => sum + point.weight, 0);
    if (spawns.length < ctx.settings.fanoutSpawns && subW < ctx.settings.fanoutWeight) {
      return undefined;
    }
    const last = spawns.at(-1);
    return {
      numbers: { spawns: spawns.length, subW: Math.round(subW * 10) / 10 },
      ...(last?.description ? { params: { description: clip(last.description, 80) } } : {}),
      since: Math.min(...spawns.map((spawn) => spawn.at), ...burn.map((point) => point.at)),
    };
  },

  R14(state, _node, _ctx, now) {
    const results = recent(state.bigResults, now);
    const worst = [...results].sort((a, b) => b.chars - a.chars)[0];
    if (!worst) return undefined;
    return {
      numbers: { charsK: Math.round(worst.chars / 1000), results: results.length },
      params: { call: clip(worst.label) },
      since: results[0]?.at ?? worst.at,
    };
  },

  R15(state, _node, _ctx, now) {
    const timeouts = recent(state.timeouts, now);
    const last = timeouts.at(-1);
    if (!last) return undefined;
    return {
      numbers: { timeoutMin: minutes(last.timeoutMs), timeouts: timeouts.length },
      params: { call: clip(last.label), ...(last.print ? { sig: last.print } : {}) },
      since: timeouts[0]?.at ?? last.at,
    };
  },

  R16(state, node, ctx, now) {
    // Ждёт очередь — это R17; ждёт человека — R1b; группа стоит — задержки нет (как у R1).
    if (!node.running || node.paused || node.heavyWait || openAsk(state, node)) return undefined;
    const longMs = ctx.settings.longCallMinutes * 60_000;
    const open = Object.values(state.openTools)
      .filter((tool) => {
        if (tool.background || SPAWN_TOOLS.has(tool.name) || tool.name === 'AskUserQuestion') {
          return false;
        }
        const elapsed = now - tool.startedAt;
        // Срок вышел — молчание уже не законно, это R1; опыт очереди говорит «так долго и идёт» — не диво.
        const inTimeout = tool.timeoutMs === undefined || tool.startedAt + tool.timeoutMs > now;
        return (
          elapsed >= longMs &&
          inTimeout &&
          !(tool.expectMs !== undefined && tool.expectMs >= elapsed)
        );
      })
      .sort((a, b) => a.startedAt - b.startedAt)[0];
    if (!open) return undefined;
    return {
      numbers: { openMin: minutes(now - open.startedAt) },
      params: { call: clip(open.label ?? open.name), ...(open.print ? { sig: open.print } : {}) },
      since: open.startedAt,
    };
  },

  R17(_state, node, ctx, now) {
    const wait = node.heavyWait;
    if (!wait || now - wait.since < ctx.settings.queueWaitMinutes * 60_000) return undefined;
    return {
      numbers: { waitMin: minutes(now - wait.since), ahead: wait.ahead },
      ...(wait.command ? { params: { command: clip(wait.command) } } : {}),
      since: wait.since,
    };
  },

  R18(state, _node, ctx, now) {
    const span = ctx.settings.denialMinutes * 60_000;
    const denials = state.denials.filter((denial) => denial.at <= now && now - denial.at <= span);
    const last = denials.at(-1);
    const first = denials[0];
    if (!last || !first || denials.length < ctx.settings.denialRepeats) return undefined;
    return {
      numbers: { denials: denials.length, spanMin: Math.max(1, minutes(last.at - first.at)) },
      params: { guard: clip(last.guard, 80) },
      since: first.at,
    };
  },

  R19(state, _node, ctx, now) {
    const at = state.firstCallAt;
    const first = state.firstCtx;
    if (at === undefined || first === undefined || now - at > EVENT_HOLD_MS) return undefined;
    // `!(a >= b)`, а не `a < b`: битое число (NaN из кривого потока) — не тяжёлый старт.
    if (!(first >= ctx.settings.firstContextTokens)) return undefined;
    return { numbers: { firstK: Math.round(first / 1000) }, since: at };
  },
};

/**
 * Одна причина — один сигнал. R16 (долгий вызов) при R1 (молчание) — та же
 * беда; ревью в работе (R5) уже называет веер его же субагентов (R13); цикл
 * опроса (R11), начатый после упора в срок (R15), — следствие R15. Падения
 * проверки (R24) при её повторах подряд (R4) — тот же круг; опрос (R11) тем же
 * вызовом, что гасит чужие процессы (R26), — это R26; сбои связи (R30) при
 * исчерпанном лимите (R10) — следствие лимита.
 */
function dedupe(hits: RuleHit[]): RuleHit[] {
  const by = new Map(hits.map((hit) => [hit.rule, hit]));
  const r15 = by.get('R15');
  const r26 = by.get('R26');
  const r4 = by.get('R4');
  return hits.filter((hit) => {
    if (hit.rule === 'R16') return !by.has('R1');
    if (hit.rule === 'R13') return !by.has('R5');
    if (hit.rule === 'R11') {
      return !(r15 && hit.since >= r15.since) && !(r26 && hit.since === r26.since);
    }
    if (hit.rule === 'R24') return !(r4 && r4.params?.command === hit.params?.call);
    if (hit.rule === 'R30') return !by.has('R10');
    return true;
  });
}

/**
 * Правила сессии по её состоянию: список попаданий (пустой — всё спокойно). R8/R9/R21 —
 * не здесь. На паузе группы — только R20: прочие условия (молчание, вопрос, упор в
 * срок) человек уже видит сам, он её и остановил. `scope` `chat` — одиночный чат
 * панели: только `SINGLE_RULES` (паузы группы у него нет).
 */
export function evaluate(
  state: WatchState,
  node: WatchNode,
  ctx: WatchContext,
  now: number,
  scope: WatchScope = 'group',
): RuleHit[] {
  if (node.paused && scope === 'group') {
    // На паузе — только то, что пауза не удержала: действия (R20) и свой сервер (R36).
    return [pausedActivity(state, node), orphanPorts(state, node, ctx, now)].filter(
      (hit): hit is RuleHit => hit !== undefined,
    );
  }
  const hits: RuleHit[] = [];
  for (const [rule, check] of Object.entries(RULES) as Array<[GroupWatchRule, Rule]>) {
    if (scope === 'chat' && !SINGLE_RULES.has(rule)) continue;
    const hit = check(state, node, ctx, now, scope);
    if (!hit) continue;
    const { severity, ...rest } = hit;
    hits.push({ rule, severity: severity ?? GROUP_WATCH_SEVERITY[rule], ...rest });
  }
  return dedupe(hits);
}

/** Вызов модели в расходе группы: когда и сколько W. */
export interface BurnPoint {
  t: number;
  weight: number;
  /** Вызов субагента (не остаток сверки): доля веера в расходе группы (R13 против R8). */
  sub?: boolean;
}

/** Поднятый R8 гаснет, только когда расход упал ниже этой доли порога (гистерезис). */
export const BURN_CLEAR_SHARE = 0.85;

/** Тяжёлая проверка группы (R21): из какого разговора. */
export interface GatePoint extends HeavyCheck {
  chatId: string;
}

/** Окно R21: тяжёлые проверки группы за последние 6 часов — дольше группа не живёт одним заходом. */
export const GATE_WINDOW_MS = 6 * 60 * 60_000;

/**
 * R21 — тяжёлые проверки по кругу во ВСЕЙ группе: полный гейт в работе, ещё один в
 * ревью, ещё один в доставке, с правками между. R4 этого не видит — правка
 * сбрасывает его счёт, а разговоры у звеньев разные. 23.10 группа прогнала полный
 * гейт пять раз за 1 ч 45 мин (73 мин гейтов), правило одного гейта в конце держит
 * только сессию, не группу. Держится полчаса после последней проверки.
 */
export function groupGates(
  points: readonly GatePoint[],
  settings: GroupWatch,
  now: number,
): RuleHit | undefined {
  const window = points
    .filter((point) => point.endedAt <= now && now - point.endedAt <= GATE_WINDOW_MS)
    .sort((a, b) => a.endedAt - b.endedAt);
  const last = window.at(-1);
  const nth = window[settings.gateRepeats - 1];
  if (!last || !nth || now - last.endedAt > EVENT_HOLD_MS) return undefined;
  const total = window.reduce((sum, point) => sum + point.minutes, 0);
  return {
    rule: 'R21',
    severity: GROUP_WATCH_SEVERITY.R21,
    numbers: { gates: window.length, totalMin: Math.round(total) },
    params: { command: clip(last.label) },
    since: nth.endedAt,
  };
}

/** Доля субагентов в расходе группы, с которой веер (R13) — причина расхода и R8 молчит. */
export const FANOUT_BURN_SHARE = 0.5;

/** Окно R8: вызовы группы за последние `burnMinutes`. */
function burnWindow(points: readonly BurnPoint[], settings: GroupWatch, now: number): BurnPoint[] {
  const span = settings.burnMinutes * 60_000;
  return points.filter((point) => point.t <= now && now - point.t <= span);
}

/** Доля вызовов субагентов в весе окна R8, 0…1; пустое окно — 0. */
export function subBurnShare(
  points: readonly BurnPoint[],
  settings: GroupWatch,
  now: number,
): number {
  const window = burnWindow(points, settings, now);
  const total = window.reduce((sum, point) => sum + point.weight, 0);
  if (!(total > 0)) return 0;
  const sub = window.reduce((sum, point) => sum + (point.sub ? point.weight : 0), 0);
  return sub / total;
}

/**
 * R8 — расход ВСЕЙ группы, W в час за последние `burnMinutes`: звенья работы,
 * ревью и доставки и их субагенты вместе. Две сессии по 25 W/ч при пороге 40 —
 * группа жжёт 50, хотя ни одна сессия порога не перешла.
 *
 * `active` — сигнал уже поднят: он гаснет только ниже `BURN_CLEAR_SHARE` порога.
 * Без этого расход, гуляющий у порога (40.0…40.9 W/ч у группы 23.10), поднимал и
 * закрывал сигнал каждую минуту — 13 рядов за 6 минут.
 */
export function groupBurn(
  points: readonly BurnPoint[],
  settings: GroupWatch,
  now: number,
  active = false,
): RuleHit | undefined {
  const window = burnWindow(points, settings, now);
  // Один тяжёлый вызов — не «жжёт»: нужен поток.
  if (window.length < 3) return undefined;
  const weight = window.reduce((sum, point) => sum + point.weight, 0);
  const perHour = (weight * 60) / settings.burnMinutes;
  const limit = active ? settings.burnPerHour * BURN_CLEAR_SHARE : settings.burnPerHour;
  if (perHour <= limit) return undefined;
  return {
    rule: 'R8',
    severity: GROUP_WATCH_SEVERITY.R8,
    numbers: { perHour: Math.round(perHour * 10) / 10 },
    since: Math.min(...window.map((point) => point.t)),
  };
}

/** Замер пятичасового окна: доля 0…1, сброс — секунды эпохи. */
export interface LimitPoint {
  t: number;
  utilization: number;
  resetsAt: number;
}

/**
 * R9 — прогноз пятичасового окна к сбросу по замерам ВСЕГО аккаунта (журнал
 * лимита всех прогонов и живой поток): окно одно на подписку, и N групп не
 * должны давать N разных прогнозов одного факта.
 */
export function accountProjection(
  samples: readonly LimitPoint[],
  settings: GroupWatch,
  now: number,
): RuleHit | undefined {
  const sorted = samples.filter((point) => point.t <= now).sort((a, b) => a.t - b.t);
  const latest = sorted.at(-1);
  if (!latest) return undefined;
  const from = now - settings.projectionMinutes * 60_000;
  const points = sorted.filter((point) => point.t >= from && point.resetsAt === latest.resetsAt);
  const first = points[0];
  if (!first || latest.t - first.t < 5 * 60_000) return undefined;
  const slope = (latest.utilization - first.utilization) / (latest.t - first.t);
  if (slope <= 0) return undefined;
  const resetMs = latest.resetsAt * 1000;
  const projected = latest.utilization + slope * Math.max(0, resetMs - latest.t);
  if (projected * 100 <= settings.projectionPercent) return undefined;
  return {
    rule: 'R9',
    severity: GROUP_WATCH_SEVERITY.R9,
    numbers: {
      projectedPct: Math.round(projected * 100),
      nowPct: Math.round(latest.utilization * 100),
      resetMin: Math.max(0, minutes(resetMs - now)),
    },
    since: first.t,
  };
}

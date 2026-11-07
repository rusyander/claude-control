import type { FirstPassSample, LearnedKey } from '@agentdeck/contracts/core/economy';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { TASK_CLASSES, type TaskClass } from '@agentdeck/contracts/core/scenario';
import { p95 } from '../../lib/stats.ts';
import { budgetTokens, quantile } from '../cost.ts';
import { defaultRoleOf } from '../tier-ladder.ts';
import {
  TOOL_P95_MIN_SAMPLES,
  type JournalSamples,
  type LearnedReset,
  type LearnedStats,
  type LearnedTable,
  type StepSample,
  type TaskSample,
} from './learned.types.ts';

/**
 * Выученное из законченных журналов задач (03 §Economy; смысл панельного `lowered-journal`:
 * понижённый прогон, его исход и расход). Ключ — проект × вид шага × переходник × маршрут ×
 * модель. Шаг под правкой человека (`override.set` на задачу, его единицу или его самого, или
 * решение `tier` с `learning: override`) в учёбу не идёт: он меряет чужой выбор. Журнал без
 * `task.ended` не учит — его шаги ещё не кончились.
 */

/** Ключ строки (этап 11, P140: роль входит; нет роли — роль вида шага, как у строк v2). */
export const keyOf = (k: LearnedKey): string =>
  [
    k.project,
    k.stepKind,
    k.adapter,
    k.route,
    k.model ?? '',
    k.role ?? defaultRoleOf(k.stepKind) ?? '',
  ].join('|');
export const kindKeyOf = (k: Pick<LearnedKey, 'project' | 'stepKind'>): string =>
  `${k.project}|${k.stepKind}`;

interface StepAcc {
  unitId: string;
  stepKind: string;
  /** Шаг сценария в единице (`<unitId>|<stepDefId>`): попытки одного шага. */
  def: string;
  /**
   * Первая судимая попытка шага сценария в единице (`round` и повторы после красной — не первые;
   * попытка, кончившаяся не по вине ступени, первой не считается — первой станет следующая).
   */
  first: boolean;
  /** Красная проверка после заявления (`checked-red`): первый проход не засчитан. */
  red: boolean;
  startedAt: number;
  endedAt: number | null;
  outcome: StepSample['outcome'] | null;
  /** Причина конца шага (`step.ended.reason`): по ней видно, судит ли конец ступень. */
  endReason: string;
  key: Omit<LearnedKey, 'project' | 'stepKind'> | null;
  lowered: boolean;
  override: boolean;
  sessions: Set<string>;
}

type Usage = JournalLine<'turn.usage'>['data'];

/** Что строка `tier` шага (по конверту `stepId`) даёт обучению: ступень и ключ базового выбора. */
interface StepTier {
  model: string | null;
  effort: string | null;
  learnedKey: LearnedKey | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function stepTierOf(out: unknown): StepTier {
  const o = (out ?? {}) as { model?: unknown; effort?: unknown; learnedKey?: unknown };
  const k = o.learnedKey as Partial<LearnedKey> | null | undefined;
  const learnedKey =
    k &&
    typeof k.project === 'string' &&
    typeof k.stepKind === 'string' &&
    typeof k.adapter === 'string' &&
    typeof k.route === 'string'
      ? (k as LearnedKey)
      : null;
  return { model: str(o.model), effort: str(o.effort), learnedKey };
}

const isClass = (v: unknown): v is TaskClass => TASK_CLASSES.some((c) => c === v);

/**
 * Концы шага, которые не судят ступень (P140: проба первого прохода меряет модель на ступени):
 * остановка человеком или наблюдателем (`stopped: <сигнал>`), отказ дороги открыть сеанс
 * (`no-outcome: session refused …`). Такой шаг пробы не даёт вовсе — ни провала, ни прохода.
 * `superseded: red, round N` сюда НЕ входит: это красный вердикт проверки (`reenter-step`) —
 * настоящий провал первого прохода. Префиксы — `END_REASON` дирижёра (часть экономики его не
 * импортирует; совпадение держит тест обучения, который строит причины из `END_REASON`).
 */
const NOT_THE_RUNGS = [/^stopped: /, /^no-outcome: session refused /];
const notTheRungs = (reason: string): boolean => NOT_THE_RUNGS.some((re) => re.test(reason));

const data = <K extends JournalLine['kind']>(l: JournalLine, _k: K) => (l as JournalLine<K>).data;

function overridden(
  rows: readonly JournalLine<'override.set'>['data'][],
  taskId: string,
  stepId: string,
  unitId: string,
): boolean {
  return rows.some(
    (r) =>
      (r.scope === 'task' && r.scopeId === taskId) ||
      (r.scope === 'unit' && r.scopeId === unitId) ||
      (r.scope === 'step' && r.scopeId === stepId),
  );
}

/** Образцы одного журнала; `null` — задача не закончена. */
export function samplesOfJournal(
  taskId: string,
  lines: readonly JournalLine[],
): JournalSamples | null {
  const ended = lines.find((l) => l.kind === 'task.ended');
  if (!ended) return null;
  const units = new Map<string, string>();
  const steps = new Map<string, StepAcc>();
  const sessionStep = new Map<string, string>();
  const lastTier = new Map<string, { applied?: unknown; learning?: unknown }>();
  const overrides: JournalLine<'override.set'>['data'][] = [];
  const usage = new Map<string, Usage>();
  const jumps: { at: number; ms: number }[] = [];
  const toolMs: Record<string, number[]> = {};
  /** Начало сеанса шага (не чата) и его законченные отрезки — длительность считается после сна. */
  const sessionAt = new Map<string, number>();
  const sessionSpans: { start: number; end: number }[] = [];
  let scenarioId: string | null = null;
  // Этап 11: строка `tier` по шагу, класс задачи.
  const tierOfStep = new Map<string, StepTier>();
  let taskClass: TaskClass | null = null;
  for (const l of lines) {
    switch (l.kind) {
      case 'tool.event': {
        // Длительность вызова по классу действия — в активном времени (её так пишет кран W).
        const d = data(l, 'tool.event');
        // Строка отказа CLI — не вызов: длительности у неё нет.
        if (!d.denied) (toolMs[d.effectClass] ??= []).push(d.ms);
        break;
      }
      case 'task.created': {
        const d = data(l, 'task.created');
        scenarioId = d.scenario?.id ?? null;
        taskClass = d.lead?.class ?? taskClass;
        break;
      }
      case 'unit.created': {
        const d = data(l, 'unit.created');
        units.set(d.unitId, d.repoKey);
        break;
      }
      case 'override.set':
        overrides.push(data(l, 'override.set'));
        break;
      case 'decision': {
        const d = data(l, 'decision');
        if (d.class === 'tier' && l.unitId)
          lastTier.set(l.unitId, (d.output ?? {}) as { applied?: unknown; learning?: unknown });
        if (d.class === 'tier' && l.stepId) tierOfStep.set(l.stepId, stepTierOf(d.output));
        const cls = (d.output as { class?: unknown } | null)?.class;
        if (d.class === 'classify' && isClass(cls)) taskClass = cls;
        break;
      }
      case 'step.transition': {
        const d = data(l, 'step.transition');
        const s = steps.get(d.stepId);
        if (s && d.event === 'checked-red') s.red = true;
        break;
      }
      case 'step.started': {
        const d = data(l, 'step.started');
        steps.set(d.stepId, {
          def: `${d.unitId}|${d.stepDefId}`,
          first: false,
          red: false,
          unitId: d.unitId,
          stepKind: d.stepKind,
          startedAt: l.at,
          endedAt: null,
          outcome: null,
          endReason: '',
          key: null,
          lowered: false,
          override: false,
          sessions: new Set(),
        });
        break;
      }
      case 'session.started': {
        const d = data(l, 'session.started');
        const s = steps.get(d.stepId);
        if (!s) break;
        // Чат — интерактивная строка вне счёта мест (P141): место распределителя не держит.
        if (s.stepKind !== 'chat') sessionAt.set(d.sessionId, l.at);
        sessionStep.set(d.sessionId, d.stepId);
        s.sessions.add(d.sessionId);
        if (s.key) break;
        // Первый сеанс шага задаёт ключ: смена маршрута внутри шага — подмена, а не другой шаг.
        s.key = { adapter: d.adapter, route: d.route.id, model: d.modelServed ?? d.modelAsked };
        const tier = lastTier.get(s.unitId);
        s.lowered = tier?.applied === 'lowered';
        s.override = tier?.learning === 'override';
        break;
      }
      case 'turn.usage': {
        const d = data(l, 'turn.usage');
        // Повтор по messageId ЗАМЕНЯЕТ прежнюю строку (сборка хода по частям), не прибавляется.
        usage.set(`${d.sessionId}|${d.messageId}`, d);
        break;
      }
      case 'step.ended': {
        const d = data(l, 'step.ended');
        const s = steps.get(d.stepId);
        if (s) {
          s.endedAt = l.at;
          s.outcome = d.outcome;
          s.endReason = d.reason;
        }
        break;
      }
      case 'session.transition': {
        // Законченный сеанс — выход живого процесса; не стартовавший (выход из `starting`) и
        // потерянный (`host-dead`) длительности держания места не дают.
        const d = data(l, 'session.transition');
        const start = sessionAt.get(d.sessionId);
        if (start === undefined || d.event !== 'exited' || d.from === 'starting') break;
        sessionSpans.push({ start, end: l.at });
        sessionAt.delete(d.sessionId);
        break;
      }
      case 'clock.jump':
        jumps.push({ at: l.at, ms: data(l, 'clock.jump').suspendedMs });
        break;
      default:
    }
  }
  const tokens = new Map<string, number>();
  const turns = new Map<string, number>();
  for (const u of usage.values()) {
    const stepId = sessionStep.get(u.sessionId) ?? sessionStep.get(u.parentSessionId ?? '');
    if (!stepId) continue;
    tokens.set(stepId, (tokens.get(stepId) ?? 0) + budgetTokens(u));
    if (!u.remainder && !u.subagent) turns.set(stepId, (turns.get(stepId) ?? 0) + 1);
  }
  // Первая попытка — по порядку начала; конец не по вине ступени первую попытку не занимает.
  const judged = new Set<string>();
  for (const s of steps.values()) {
    s.first = !notTheRungs(s.endReason) && !judged.has(s.def);
    if (s.first) judged.add(s.def);
  }
  const out: StepSample[] = [];
  let taskTokens = 0;
  let taskMs = 0;
  for (const [stepId, s] of steps) {
    const project = units.get(s.unitId);
    if (s.endedAt === null || s.outcome === null || !project) continue;
    const slept = jumps
      .filter((j) => j.at > s.startedAt && j.at <= (s.endedAt as number))
      .reduce((sum, j) => sum + j.ms, 0);
    const activeMs = Math.max(0, s.endedAt - s.startedAt - slept);
    taskTokens += tokens.get(stepId) ?? 0;
    taskMs += activeMs;
    if (!s.key || s.override || overridden(overrides, taskId, stepId, s.unitId)) continue;
    const tier = tierOfStep.get(stepId);
    // Ключ — ключ базового выбора суда `tier` (до подъёмов: пробы копятся там, где их читают).
    // Строки без `learnedKey` пишут только журналы до этапа 11 — у их единиц роли куска нет,
    // поэтому ключ первого сеанса берёт роль вида шага (как строки v2). Роль куска сюда не
    // доходит: этап 11 пишет её в `learnedKey` каждой строки `tier` шага с единицей.
    const role = defaultRoleOf(s.stepKind);
    const key: LearnedKey = tier?.learnedKey ?? {
      project,
      stepKind: s.stepKind,
      ...s.key,
      ...(role ? { role } : {}),
    };
    out.push({
      key,
      tokens: tokens.get(stepId) ?? 0,
      activeMs,
      turns: turns.get(stepId) ?? 0,
      outcome: s.outcome,
      lowered: s.lowered,
      firstPass:
        s.first && s.outcome !== 'skipped'
          ? {
              sampleId: stepId,
              at: s.startedAt,
              passed: s.outcome === 'done' && !s.red,
              rung: `${tier?.model ?? s.key.model ?? 'cli default'}·${tier?.effort ?? 'cli default'}`,
              class: taskClass,
            }
          : null,
    });
  }
  const task: TaskSample = {
    taskId,
    projects: [...new Set(units.values())].sort(),
    scenarioId,
    tokens: taskTokens,
    activeMs: taskMs,
    outcome: data(ended, 'task.ended').outcome,
  };
  const sessionMs = sessionSpans.map(({ start, end }) => {
    const slept = jumps
      .filter((j) => j.at > start && j.at <= end)
      .reduce((sum, j) => sum + j.ms, 0);
    return Math.max(0, end - start - slept);
  });
  return { steps: out, task, toolMs, sessionMs };
}

/** Медиана законченного сеанса по всем журналам; вклад без `sessionMs` (старый кэш) — без образцов. */
function sessionsOf(journals: readonly JournalSamples[]): NonNullable<LearnedTable['sessions']> {
  const all = journals.flatMap((j) => j.sessionMs ?? []);
  return { medianMs: quantile(all, 0.5), samples: all.length };
}

/** p95 вызова по классу действия поверх всех журналов; класс с малым числом образцов не выучен. */
function toolP95Of(journals: readonly JournalSamples[]): Record<string, number> {
  const by = new Map<string, number[]>();
  for (const j of journals)
    for (const [cls, ms] of Object.entries(j.toolMs)) by.set(cls, [...(by.get(cls) ?? []), ...ms]);
  const out: Record<string, number> = {};
  for (const [cls, ms] of by) {
    if (ms.length < TOOL_P95_MIN_SAMPLES) continue;
    const value = p95(ms);
    if (value !== null) out[cls] = value;
  }
  return out;
}

function statsOf(samples: readonly StepSample[]): LearnedStats {
  const ran = samples.filter((s) => s.outcome !== 'skipped');
  const ord = (xs: number[]) => quantile(xs, 0.9) ?? 0;
  return {
    runs: ran.length,
    failures: ran.filter((s) => s.outcome === 'failed').length,
    loweredFailures: ran.filter((s) => s.lowered && s.outcome === 'failed').length,
    p90Tokens: ord(ran.map((s) => s.tokens)),
    p90Minutes: ord(ran.map((s) => s.activeMs / 60_000)),
    medianTurns:
      quantile(
        ran.map((s) => s.turns),
        0.5,
      ) ?? 0,
  };
}

/** Пробы первого прохода по ключу, по времени; пробы до сброса ключа человеком не входят. */
function firstPassOf(
  journals: readonly JournalSamples[],
  resets: Readonly<Record<string, LearnedReset>>,
): Record<string, FirstPassSample[]> {
  const by: Record<string, FirstPassSample[]> = {};
  for (const j of journals)
    for (const s of j.steps) {
      if (!s.firstPass) continue;
      const key = keyOf(s.key);
      const reset = resets[key];
      if (reset && s.firstPass.at < reset.at) continue;
      (by[key] ??= []).push(s.firstPass);
    }
  for (const samples of Object.values(by)) samples.sort((a, b) => a.at - b.at);
  return by;
}

export function learnFrom(
  journals: readonly JournalSamples[],
  skipped = 0,
  resets: Readonly<Record<string, LearnedReset>> = {},
): LearnedTable {
  const group = (key: (s: StepSample) => string): Record<string, LearnedStats> => {
    const by = new Map<string, StepSample[]>();
    for (const j of journals)
      for (const s of j.steps) by.set(key(s), [...(by.get(key(s)) ?? []), s]);
    return Object.fromEntries([...by].map(([k, v]) => [k, statsOf(v)]));
  };
  return {
    byKey: group((s) => keyOf(s.key)),
    byKind: group((s) => kindKeyOf(s.key)),
    tasks: journals.map((j) => j.task),
    skipped,
    toolMsP95: toolP95Of(journals),
    sessions: sessionsOf(journals),
    firstPass: firstPassOf(journals, resets),
    resets: { ...resets },
  };
}

export function learnedFor(table: LearnedTable, key: LearnedKey): LearnedStats | null {
  return table.byKey[keyOf(key)] ?? null;
}

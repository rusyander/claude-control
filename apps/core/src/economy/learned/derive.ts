import type { LearnedKey } from '@agentdeck/contracts/core/economy';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { p95 } from '../../lib/stats.ts';
import { budgetTokens, quantile } from '../cost.ts';
import {
  TOOL_P95_MIN_SAMPLES,
  type JournalSamples,
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

export const keyOf = (k: LearnedKey): string =>
  [k.project, k.stepKind, k.adapter, k.route, k.model ?? ''].join('|');
export const kindKeyOf = (k: Pick<LearnedKey, 'project' | 'stepKind'>): string =>
  `${k.project}|${k.stepKind}`;

interface StepAcc {
  unitId: string;
  stepKind: string;
  startedAt: number;
  endedAt: number | null;
  outcome: StepSample['outcome'] | null;
  key: Omit<LearnedKey, 'project' | 'stepKind'> | null;
  lowered: boolean;
  override: boolean;
  sessions: Set<string>;
}

type Usage = JournalLine<'turn.usage'>['data'];

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
  let scenarioId: string | null = null;
  for (const l of lines) {
    switch (l.kind) {
      case 'tool.event': {
        // Длительность вызова по классу действия — в активном времени (её так пишет кран W).
        const d = data(l, 'tool.event');
        // Строка отказа CLI — не вызов: длительности у неё нет.
        if (!d.denied) (toolMs[d.effectClass] ??= []).push(d.ms);
        break;
      }
      case 'task.created':
        scenarioId = data(l, 'task.created').scenario?.id ?? null;
        break;
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
        break;
      }
      case 'step.started': {
        const d = data(l, 'step.started');
        steps.set(d.stepId, {
          unitId: d.unitId,
          stepKind: d.stepKind,
          startedAt: l.at,
          endedAt: null,
          outcome: null,
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
        }
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
    out.push({
      key: { project, stepKind: s.stepKind, ...s.key },
      tokens: tokens.get(stepId) ?? 0,
      activeMs,
      turns: turns.get(stepId) ?? 0,
      outcome: s.outcome,
      lowered: s.lowered,
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
  return { steps: out, task, toolMs };
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

export function learnFrom(journals: readonly JournalSamples[], skipped = 0): LearnedTable {
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
  };
}

export function learnedFor(table: LearnedTable, key: LearnedKey): LearnedStats | null {
  return table.byKey[keyOf(key)] ?? null;
}

/** Падал ли этот вид шага проекта на этой (пониженной) модели — тогда не понижать (03:144). */
export function lowerFailed(table: LearnedTable, key: LearnedKey): boolean {
  return (learnedFor(table, key)?.loweredFailures ?? 0) > 0;
}

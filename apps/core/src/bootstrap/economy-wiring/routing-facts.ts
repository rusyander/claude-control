import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { LearnedRaise, LearnedRaiseQuery } from '@agentdeck/contracts/core/economy';
import type { LeadRole, LeadSection, TaskClass } from '@agentdeck/contracts/core/lead';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { crossAdapterOf } from '../../conductor/next/lead-gate.ts';
import { crossStepsOf } from '../../economy/cross-steps.ts';
import { learnedRaiseOf, type LearnedTable } from '../../economy/learned/index.ts';
import { resolveLeadSettings } from '../../economy/lead-settings/index.ts';
import { reviewAuthorOf } from '../../economy/review-author.ts';
import { stepRoleOf } from '../../economy/tier-ladder.ts';
import type {
  EscalationCause,
  TierAuthor,
  TierEscalation,
  TierInput,
  TierRung,
} from '../../economy/tier.types.ts';
import type { StepRecord, TaskFoldState } from '../../journal/reduce/reduce.types.ts';

/**
 * Факты одного шага для суда `tier` (этап 11, D7, D21, F1) — чистая функция над свёрткой и
 * строками журнала задачи: роль куска (`unit.created.role`, иначе роль вида шага), строка роли
 * действующих настроек ведущего (только у задачи ведущего), прошлая неудачная попытка того же
 * шага в единице (эскалация с причиной и записью вывода проверки), автор для ревьюера, «понижение
 * уже падало», ключ проекта и класс задачи для обучения. Этап 12 (P185): второму ревью —
 * CLI первого ревьюера как `avoidAdapter`, прочим шагам — плановый маршрут без его сессий.
 */

export interface RoutingFactsDeps {
  /** Раздел `lead` настройки ядра; нет — одни умолчания профиля. */
  leadSection?: () => LeadSection | undefined;
  /**
   * Подъём по обучению (`economy/learned` `promotionOf` над последней таблицей); `section` —
   * раздел ведущего этого прохода суда (порог окна), чтобы не читать настройку ядра второй раз.
   */
  learnedRaise?: (
    query: LearnedRaiseQuery,
    section?: () => LeadSection | undefined,
  ) => LearnedRaise | null;
}

/**
 * Подъём по обучению для суда `tier` (F1): последняя прочитанная таблица выученного, порог окна —
 * из действующих настроек ведущего проекта ключа (`promotion`, правка доходит без перезапуска).
 * Таблицы ещё нет — подъёма нет. `refresh` — просьба перечитать выученное (не ждёт чтения: суд
 * идёт по прочитанному, свежие журналы дойдут к следующему шагу).
 */
export function learnedRaiseFor(deps: {
  table: () => LearnedTable | null;
  leadSection?: () => LeadSection | undefined;
  refresh?: () => void;
}): NonNullable<RoutingFactsDeps['learnedRaise']> {
  return (query, section) => {
    deps.refresh?.();
    const table = deps.table();
    if (!table) return null;
    const eff = resolveLeadSettings({
      section: (section ?? deps.leadSection)?.(),
      repoKey: query.key.project,
      machine: {},
    });
    return learnedRaiseOf(table, query, eff.settings.promotion);
  };
}

interface TierOut {
  adapter?: unknown;
  model?: unknown;
  effort?: unknown;
  applied?: unknown;
  refused?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Последняя строка `tier` каждого шага (по конверту `stepId`, его пишет `routeStep`). */
function tierByStep(lines: readonly JournalLine[]): Map<string, TierOut> {
  const out = new Map<string, TierOut>();
  for (const l of lines) {
    if (l.kind !== 'decision' || !l.stepId) continue;
    const d = (l as JournalLine<'decision'>).data;
    if (d.class !== 'tier') continue;
    const o = d.output as TierOut | null;
    if (o && o.refused !== true) out.set(l.stepId, o);
  }
  return out;
}

/** Ступень, на которой шла попытка: её решение `tier`, иначе `session.started` сессии шага. */
function rungOf(
  stepId: string,
  tiers: ReadonlyMap<string, TierOut>,
  lines: readonly JournalLine[],
): TierRung {
  const t = tiers.get(stepId);
  if (t) return { model: str(t.model), effort: str(t.effort) };
  let rung: TierRung = { model: null, effort: null };
  for (const l of lines) {
    if (l.kind !== 'session.started') continue;
    const d = (l as JournalLine<'session.started'>).data;
    if (d.stepId === stepId) rung = { model: d.modelAsked, effort: d.effort };
  }
  return rung;
}

/** Запись вывода последней проверки шага (по ней бриф берёт отрывок провала). */
function recordOf(state: TaskFoldState, stepId: string): string | null {
  let id: string | null = null;
  for (const c of Object.values(state.checks))
    if (c.run?.stepId === stepId && c.recordId) id = c.recordId;
  return id;
}

function endedSeq(lines: readonly JournalLine[], stepId: string): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] as JournalLine;
    if (l.kind === 'step.ended' && (l as JournalLine<'step.ended'>).data.stepId === stepId)
      return l.seq;
  }
  return null;
}

/** Почему попытка провалилась: красная проверка или неудача на пониженной модели; иначе `null`. */
function failureOf(
  state: TaskFoldState,
  stepId: string,
  rec: StepRecord,
  tiers: ReadonlyMap<string, TierOut>,
  lines: readonly JournalLine[],
): EscalationCause | null {
  if (rec.red)
    return { stepId, seq: rec.red.seq, recordId: recordOf(state, stepId), why: 'red-check' };
  if (rec.outcome !== 'failed' || tiers.get(stepId)?.applied !== 'lowered') return null;
  const seq = endedSeq(lines, stepId);
  if (seq === null) return null;
  return { stepId, seq, recordId: recordOf(state, stepId), why: 'lowered-failure' };
}

/** Прошлые попытки шага сценария в единице, новые первыми; текущая попытка исключена. */
function priorAttempts(
  state: TaskFoldState,
  step: { stepId: string | null; unitId: string | null; def: StepDef },
): [string, StepRecord][] {
  const current = step.stepId ? state.steps[step.stepId] : undefined;
  return Object.entries(state.steps)
    .filter(
      ([id, s]) =>
        id !== step.stepId &&
        s.stepDefId === step.def.id &&
        (step.unitId === null || s.unitId === step.unitId) &&
        (current === undefined || s.startedSeq < current.startedSeq),
    )
    .sort(([, a], [, b]) => b.startedSeq - a.startedSeq);
}

export function escalationOf(
  state: TaskFoldState,
  lines: readonly JournalLine[],
  step: { stepId: string | null; unitId: string | null; def: StepDef },
  tiers: ReadonlyMap<string, TierOut> = tierByStep(lines),
): TierEscalation | null {
  const prior = priorAttempts(state, step)[0];
  if (!prior) return null;
  const cause = failureOf(state, prior[0], prior[1], tiers, lines);
  return cause ? { cause, from: rungOf(prior[0], tiers, lines) } : null;
}

/**
 * Автор для ревьюера — общее правило `reviewAuthorOf` (то же у `set-model`), среди шагов с
 * решением `tier`: без него ступень автора неизвестна.
 */
function authorOf(
  state: TaskFoldState,
  step: { stepId: string | null; unitId: string | null },
  tiers: ReadonlyMap<string, TierOut>,
): TierAuthor | null {
  const id = reviewAuthorOf(state, step, (stepId) => tiers.has(stepId));
  const t = id ? tiers.get(id) : undefined;
  const adapter = str(t?.adapter);
  return t && adapter ? { adapter, model: str(t.model), effort: str(t.effort) } : null;
}

/** Шаг этого сценария уже проваливался на пониженной модели где-то в задаче. */
function lowerFailedHere(
  state: TaskFoldState,
  def: StepDef,
  tiers: ReadonlyMap<string, TierOut>,
): boolean {
  return Object.entries(state.steps).some(
    ([id, s]) =>
      s.stepDefId === def.id &&
      tiers.get(id)?.applied === 'lowered' &&
      (s.red !== undefined || s.outcome === 'failed'),
  );
}

function unitRoleOf(lines: readonly JournalLine[], unitId: string | null): LeadRole | undefined {
  if (unitId === null) return undefined;
  let role: LeadRole | undefined;
  for (const l of lines) {
    if (l.kind !== 'unit.created') continue;
    const d = (l as JournalLine<'unit.created'>).data;
    if (d.unitId === unitId && d.role) role = d.role;
  }
  return role;
}

/**
 * Строка роли действующих настроек: профиль запуска (`task.created.lead.profile`) — как профиль
 * проекта задачи, затем правки (`resolveLeadSettings`). Только у задачи с профилем ведения.
 */
function roleRowOf(
  state: TaskFoldState,
  role: LeadRole | null,
  repoKey: string | null,
  deps: RoutingFactsDeps,
): TierInput['roleRow'] {
  const pinned = state.created?.lead?.profile;
  if (!pinned || role === null) return null;
  const section = deps.leadSection?.();
  const project = repoKey === null ? undefined : section?.projects?.[repoKey];
  // Единицы без репозитория нет — профиль запуска тогда профиль машины, а не проекта.
  const patched: LeadSection =
    repoKey === null
      ? { ...section, defaults: { ...section?.defaults, profile: pinned } }
      : {
          ...section,
          projects: { ...section?.projects, [repoKey]: { ...project, profile: pinned } },
        };
  // Политика машины срезает только параллельность — строке роли она не нужна.
  const eff = resolveLeadSettings({ section: patched, repoKey, machine: {} });
  const row = eff.settings.roles[role];
  // Умолчания машины считаются профилем: строку назвал не проект.
  return { row, source: eff.roleSources[role] === 'project' ? 'project' : 'profile' };
}

function classOf(state: TaskFoldState): TaskClass | null {
  return state.lead?.taskClass?.class ?? state.created?.lead?.class ?? null;
}

/**
 * Плановый маршрут начатой задачи (P169) без сессий второго ревью: оно идёт на другом CLI нарочно,
 * и правки после него остаются на маршруте работы, а не уходят за вторым ревьюером. Само второе
 * ревью на следующем круге держится своего прошлого CLI. Ничего не меняется — поля нет, решает
 * `startedOnOf` суда маршрута.
 */
function startedOnOf(
  state: TaskFoldState,
  lines: readonly JournalLine[],
  step: { unitId: string | null; def: StepDef },
): Pick<TierInput, 'startedOn'> {
  const cross = crossStepsOf(lines);
  if (cross.size === 0) return {};
  const all = Object.values(state.sessions);
  const mine = step.unitId ? all.filter((s) => state.steps[s.stepId]?.unitId === step.unitId) : [];
  const pool = mine.length > 0 ? mine : all;
  const keep = step.def.crossOf
    ? pool.filter((s) => cross.has(s.stepId))
    : pool.filter((s) => !cross.has(s.stepId));
  const last = keep.at(-1);
  if (!last || last === pool.at(-1)) return {};
  return { startedOn: { adapter: last.adapter, route: last.route } };
}

export function routingFacts(
  state: TaskFoldState,
  lines: readonly JournalLine[],
  step: { stepId: string | null; unitId: string | null; def: StepDef },
  deps: RoutingFactsDeps = {},
): Partial<TierInput> {
  const tiers = tierByStep(lines);
  const repoKey = step.unitId ? (state.units[step.unitId]?.repoKey ?? null) : null;
  const role = stepRoleOf(unitRoleOf(lines, step.unitId), step.def.kind);
  const escalation = escalationOf(state, lines, step, tiers);
  const author = step.def.kind === 'review' ? authorOf(state, step, tiers) : null;
  // Второе ревью (P185): CLI первого ревьюера исключён — тот же факт, что у судьи формы.
  const avoid = step.def.crossOf ? crossAdapterOf(state, step.unitId, step.def.crossOf) : null;
  const { learnedRaise } = deps;
  return {
    ...startedOnOf(state, lines, step),
    ...(avoid !== null ? { avoidAdapter: avoid } : {}),
    role,
    roleRow: roleRowOf(state, role, repoKey, deps),
    escalation,
    ...(author ? { author } : {}),
    lowerFailedHere: lowerFailedHere(state, step.def, tiers),
    project: repoKey,
    taskClass: classOf(state),
    ...(learnedRaise
      ? { learnedRaise: (query: LearnedRaiseQuery) => learnedRaise(query, deps.leadSection) }
      : {}),
  };
}

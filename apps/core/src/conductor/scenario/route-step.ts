import type { WindowDecision } from '@agentdeck/contracts/core/economy';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { decideContinuation } from '../../economy/continuation.ts';
import type {
  ContinuationDecision,
  ContinuationFacts,
  ContinuationSession,
} from '../../economy/continuation.types.ts';
import { continuationDecisionBody, tierDecisionBody } from '../../economy/records.ts';
import { decideTier } from '../../economy/tier.ts';
import type { TierDecision, TierInput } from '../../economy/tier.types.ts';
import { allowedRoutesOf } from '../../journal/reduce/fold-view.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { contourNarrow } from '../../policy/resolve/resolve.ts';
import type { ContourPolicy } from '../../policy/resolve/resolve.types.ts';
import { stepClassOf } from '../next/window.ts';

/**
 * Куда идёт шаг (G7, G9): модель — судья `tier` над набором задачи, правками и маршрутами шага;
 * затем `continuation` — продолжить сессию шага или начать новую. Обе строки решения — в журнал,
 * чтобы лента и отчёт показывали, почему эта модель. Исполнитель (зона B) зовёт это один раз на
 * старте сессии шага: у `preStep` шва нет места для маршрута (CONTRACT REQUEST).
 *
 * Этап 5 (W): вход судей — факты экономики (`RoutingEnv`): окна маршрутов (держащий маршрут
 * `tier` пропускает и называет, другой годный берёт — подмена журналится классом `tier`, P46,
 * P110) и числа продолжения (E). Строки решений строит владелец судей (`economy/records.ts`).
 */

export interface StepRouting {
  tier: TierDecision;
  /** `null` — выбирать нечего: судья `tier` отказал. */
  continuation: ContinuationDecision | null;
}

/** Факты экономики для суда маршрута шага; нет — суд этапа 4 (окна не судят, чисел нет). */
export interface RoutingEnv {
  /** Вердикты окна по маршрутам разрешённого набора задачи. */
  windows?: readonly WindowDecision[];
  /**
   * Активный контур (уровень 1): `required` ведёт набор шага через свой шлюз, шлюз `down` —
   * отказ `tier` с причиной (P118); нет — набор задачи как есть.
   */
  contour?: ContourPolicy;
  /** Числа продолжения для сессии-кандидата и наличие её транскрипта. */
  continuation?(
    session: ContinuationSession,
  ): { facts?: ContinuationFacts; transcriptPresent?: boolean } | undefined;
  /** Остальное входа судьи `tier` (лестницы, выученное, реестр, «платный при отказе»). */
  tier?: Partial<
    Pick<
      TierInput,
      'ladders' | 'learnedRaise' | 'paidOnRefusal' | 'registry' | 'author' | 'lowerFailedHere'
    >
  >;
  /**
   * Факты одного шага (этап 11, D21, F1): роль и строка роли ведущего, прошлая неудачная попытка
   * (эскалация), автор для ревьюера, ключ проекта и класс задачи для обучения. Поверх `tier`.
   */
  step?(
    state: TaskFoldState,
    step: { stepId: string | null; unitId: string | null; def: StepDef },
  ): Partial<TierInput>;
}

/**
 * Сессии задачи с id шага сценария, на котором они шли. С `unitId` — только сессии шагов этой
 * единицы (этап 11, P141): сессия другой единицы идёт в её копии, и «продолжить» её значило бы
 * снять чужой живой сеанс — параллельные единицы задачи шли бы по одной.
 */
export function sessionsOf(state: TaskFoldState, unitId?: string | null): ContinuationSession[] {
  return Object.entries(state.sessions).flatMap(([sessionId, s]) => {
    const step = state.steps[s.stepId];
    if (!step) return [];
    if (unitId != null && step.unitId !== unitId) return [];
    return [
      {
        sessionId,
        stepDefId: step.stepDefId,
        state: s.state,
        adapter: s.adapter,
        route: s.route,
        startedSeq: step.startedSeq,
      },
    ];
  });
}

/** Последняя сессия шага сценария — кандидат продолжения, для которого нужны числа. */
function candidateOf(
  sessions: readonly ContinuationSession[],
  stepDefId: string,
): ContinuationSession | undefined {
  return sessions
    .filter((s) => s.stepDefId === stepDefId)
    .sort((a, b) => b.startedSeq - a.startedSeq)[0];
}

/** Чистая часть: оба решения по свёртке, без журнала. */
export function decideRouting(
  state: TaskFoldState,
  step: { stepId: string | null; unitId: string | null; def: StepDef },
  env: RoutingEnv = {},
): StepRouting {
  const created = state.created;
  // Набор сейчас: `routes.set` команды `set-route` поверх `task.created`, затем контур (P118).
  const contoured = contourNarrow(allowedRoutesOf(state), env.contour);
  const tier = decideTier({
    taskId: state.taskId,
    unitId: step.unitId,
    stepId: step.stepId,
    stepModel: step.def.model,
    allowed: contoured.ok ? contoured.set : [],
    ceiling: created?.modelCeiling ?? null,
    overrides: state.overrides,
    stepKind: step.def.kind,
    stepChecks: step.def.checks,
    // Класс шага решает, держит ли его окно маршрута: тесное окно не держит фикс (03:157), значит
    // и уводить его с маршрута не за что. Таблица окна одна — `routeWait` внутри судьи.
    stepClass: stepClassOf(step.def.kind),
    ...(env.windows ? { windows: env.windows } : {}),
    ...(created?.paidOnRefusal === undefined ? {} : { paidOnRefusal: created.paidOnRefusal }),
    ...env.tier,
    ...env.step?.(state, step),
  });
  if (!contoured.ok) tier.reasons.unshift(contoured.reason);
  else tier.reasons.push(...contoured.applied.map((a) => `${a.path}: ${a.reason}`));
  // Обязательный контур и модель никто не назвал: шлюз идёт моделью контура по умолчанию (s10 G7).
  const fill = contoured.ok ? contoured.fill : undefined;
  if (fill && tier.ok && tier.model === null && tier.route.id === fill.routeId) {
    tier.model = fill.model;
    tier.sources.model = 'contour';
    tier.reasons.push(`model ${fill.model} is the default of the required contour`);
  }
  if (!created) tier.reasons.unshift('task is not created');
  if (!tier.ok) return { tier, continuation: null };
  const sessions = sessionsOf(state, step.unitId);
  const candidate = candidateOf(sessions, step.def.id);
  const extra = candidate ? env.continuation?.(candidate) : undefined;
  const unitState = step.unitId ? (state.units[step.unitId]?.state ?? null) : null;
  const continuation = decideContinuation({
    stepDefId: step.def.id,
    next: { adapter: tier.adapter, route: tier.route },
    sessions,
    unitState,
    ...(extra?.facts ? { facts: extra.facts } : {}),
    ...(extra?.transcriptPresent === undefined
      ? {}
      : { transcriptPresent: extra.transcriptPresent }),
  });
  return { tier, continuation };
}

export function routeStep(
  task: LiveTask,
  step: { stepId: string | null; unitId: string | null; def: StepDef },
  env: RoutingEnv = {},
): StepRouting {
  const routing = decideRouting(task.state, step, env);
  const unit = step.unitId ? { unitId: step.unitId } : {};
  // `stepId` в конверте строки `tier`: по нему следующая попытка шага находит ступень прошлой
  // (эскалация), а выученное — ключ шага (этап 11).
  task.append({
    kind: 'decision',
    actor: 'core',
    ...unit,
    ...(step.stepId ? { stepId: step.stepId } : {}),
    data: { decisionId: newId(), ...tierDecisionBody(routing.tier) },
  });
  if (routing.continuation)
    task.append({
      kind: 'decision',
      actor: 'core',
      ...unit,
      data: { decisionId: newId(), ...continuationDecisionBody(routing.continuation) },
    });
  return routing;
}

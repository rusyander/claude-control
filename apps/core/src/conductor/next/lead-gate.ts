import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { candidatesOf, overrideFor } from '../../economy/tier.ts';
import { allowedRoutesOf } from '../../journal/reduce/fold-view.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { contourNarrow } from '../../policy/resolve/resolve.ts';
import type { AllowedRoute, ContourPolicy } from '../../policy/resolve/resolve.types.ts';
import { integrationSkipOf } from '../gates/integrated.ts';
import { intakeAnswerOf } from '../intake/questions.ts';
import type { NextAction } from './next.types.ts';

/**
 * Форма задачи ведущего (этап 11, W2-6, W2-8, D22) — правила судьи `next` для шага, который ещё не
 * шёл: карточка приёма принята до шага разбора — разбор пропускается; шаг с `onlyFor` вне класса
 * задачи — пропускается (причина называет класс); класс не решён — шаг идёт. Пока открыт вопрос
 * карточки или класса — оценка ждёт; «остановить» на вопросе карточки без карточки кончает задачу.
 * Пропуск — существующее действие `skip-step`; ревью и правки форма не трогает (S оставляет ревью).
 */

const LEAD_DEDUPES = ['intake:', 'classify:'] as const;

/**
 * Начало причины пропуска второго ревью без другого переходника (P185): по нему итоговый отчёт
 * называет, что изменение смотрел один ревьюер (`conductor/report/report.ts`).
 */
export const CROSS_SKIP = 'cross-review';

/**
 * Пропуск шага, которого ещё не было: причина или `null` — шаг идёт. `unitId` — единица шага
 * (второе ревью ищет первого ревьюера в ней); нет — по всей задаче.
 */
export function leadSkipOf(
  state: TaskFoldState,
  def: StepDef,
  unitId?: string,
  /** Активный контур: второе ревью ищет другой CLI в наборе после него. */
  contour?: ContourPolicy,
): string | null {
  const card = state.lead?.card;
  if (def.kind === 'intake' && card)
    return card.by === 'auto'
      ? 'intake card accepted automatically: structured acceptance, no forks'
      : 'intake card confirmed by the human';
  const cls = state.lead?.taskClass?.class;
  if (def.onlyFor && cls !== undefined && !def.onlyFor.includes(cls))
    return `task class ${cls}: step ${def.id} runs only for ${def.onlyFor.join(', ')}`;
  return profileSkipOf(state, def) ?? crossSkipOf(state, def, unitId ?? null, contour);
}

/**
 * Шаг с `onlyProfile` (этап 12, второе ревью) идёт только при профиле ведения, приколотом при
 * создании задачи (`task.created.lead.profile`). Профиля нет (задача не ведущего, журнал до
 * этапа 11) — шаг пропускается: лишний проход дороже, чем его отсутствие, и человек его не просил.
 */
function profileSkipOf(state: TaskFoldState, def: StepDef): string | null {
  if (!def.onlyProfile) return null;
  const profile = state.created?.lead?.profile;
  if (profile !== undefined && def.onlyProfile.includes(profile)) return null;
  return `lead profile ${profile ?? 'none'}: step ${def.id} runs only for ${def.onlyProfile.join(', ')}`;
}

/**
 * CLI первого ревьюера (P185): переходник последней сессии последней попытки шага `crossOf` в
 * единице. `null` — тот шаг сессии не вёл (пропущен или ещё не шёл). Тот же факт берёт суд
 * `tier` как `avoidAdapter` (`bootstrap/economy-wiring/routing-facts.ts`).
 */
export function crossAdapterOf(
  state: TaskFoldState,
  unitId: string | null,
  crossOf: string,
): string | null {
  let last: [string, number] | null = null;
  for (const [id, s] of Object.entries(state.steps)) {
    if (s.stepDefId !== crossOf || (unitId !== null && s.unitId !== unitId)) continue;
    if (!last || s.startedSeq > last[1]) last = [id, s.startedSeq];
  }
  if (!last) return null;
  let adapter: string | null = null;
  for (const sess of Object.values(state.sessions))
    if (sess.stepId === last[0]) adapter = sess.adapter;
  return adapter;
}

/**
 * Второе ревью (`crossOf`) идёт только на переходнике, отличном от первого ревьюера, внутри
 * разрешённого набора шага; CLI, приколотый человеком к единице или задаче, — единственный
 * кандидат. Другого нет — шаг пропускается с причиной `cross-review: …`, отчёт её называет: лучше
 * один ревьюер, названный честно, чем тот же CLI дважды под видом двух.
 */
function crossSkipOf(
  state: TaskFoldState,
  def: StepDef,
  unitId: string | null,
  contour: ContourPolicy | undefined,
): string | null {
  if (!def.crossOf) return null;
  const first = crossAdapterOf(state, unitId, def.crossOf);
  if (first === null)
    return `${CROSS_SKIP}: step ${def.crossOf} ran no session, nothing to cross-check; step ${def.id} skipped, no second reviewer`;
  const pinned = overrideFor(state.overrides, 'adapter', {
    taskId: state.taskId,
    unitId,
    stepId: null,
  }).value;
  if (pinned !== null)
    return pinned !== first
      ? null
      : `${CROSS_SKIP}: the human pinned adapter ${pinned}, the first reviewer's (step ${def.crossOf}); step ${def.id} skipped, the change has one reviewer`;
  const others = (allowed: readonly AllowedRoute[]): boolean =>
    candidatesOf({ stepModel: def.model, allowed }).candidates.some((r) => r.adapter !== first);
  // Тот же набор, что у суда `tier` шага (`route-step.ts`): разрешённое, затем контур. Иначе шаг
  // шёл бы на CLI, который контур уже снял, и падал бы вместо честного пропуска (W3-D).
  const narrowed = contourNarrow(allowedRoutesOf(state), contour);
  if (others(narrowed.ok ? narrowed.set : [])) return null;
  const why = others(allowedRoutesOf(state))
    ? `contour leaves no other CLI than ${first}, the first reviewer's (step ${def.crossOf})${narrowed.ok ? '' : `: ${narrowed.reason}`}`
    : `no allowed adapter other than ${first}, the first reviewer's (step ${def.crossOf})`;
  return `${CROSS_SKIP}: ${why}; step ${def.id} skipped, the change has one reviewer`;
}

function leadAsk(a: TaskFoldState['asks'][string]): boolean {
  return a.source === 'intake' || LEAD_DEDUPES.some((p) => a.dedupe?.startsWith(p) === true);
}

/** Открыт вопрос карточки или класса: форма задачи ещё не решена (ответ может её сменить). */
export function leadAskOpen(state: TaskFoldState): boolean {
  return Object.values(state.asks).some((a) => leadAsk(a) && a.state === 'open');
}

/**
 * Решение формы для шага `def` единицы `unitId`, ещё не начатого (`null` — правила формы молчат).
 */
export function leadGate(
  state: TaskFoldState,
  def: StepDef,
  unitId: string,
  contour?: ContourPolicy,
): Extract<NextAction, { kind: 'skip-step' | 'wait' | 'fail-task' }> | null {
  const asks = Object.values(state.asks).filter(leadAsk);
  if (leadAskOpen(state))
    return { kind: 'wait', reason: 'lead: the intake or class question is open' };
  const stopped = asks.find(
    (a) => a.dedupe?.startsWith('intake:') === true && intakeAnswerOf(a.answer ?? '') === 'stop',
  );
  if (stopped && !state.lead?.card)
    return { kind: 'fail-task', reason: 'intake: the human stopped the task on the intake card' };
  // Единица интеграции (W3-18b) идёт только своими шагами, прочие их пропускают.
  const role = integrationSkipOf(state, def.id, unitId);
  if (role !== null)
    return { kind: 'skip-step', unitId, stepDefId: def.id, round: 0, basis: 'core', reason: role };
  const skip = leadSkipOf(state, def, unitId, contour);
  if (skip === null) return null;
  return { kind: 'skip-step', unitId, stepDefId: def.id, round: 0, basis: 'core', reason: skip };
}

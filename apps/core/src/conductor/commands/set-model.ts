import type { COMMAND_FIELDS } from '@agentdeck/contracts/core/commands';
import type { z } from 'zod';
import { reviewAuthorOf } from '../../economy/review-author.ts';
import { decideTier } from '../../economy/tier.ts';
import { modelRank } from '../../economy/tier-ladder.ts';
import type { OverrideRow, TierLadder } from '../../economy/tier.types.ts';
import { allowedRoutesOf } from '../../journal/reduce/fold-view.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import {
  riskyOf,
  type ModelRank,
  type ReviewPair,
  type StepModel,
} from '../../policy/resolve/risky.ts';
import type { ApplyCommand, CommandResult } from './commands.types.ts';
import { applied, reject } from './outcome.ts';

/**
 * Смена модели и CLI (G9): правка уровня — задача, единица или шаг — строками `override.set`.
 * Принимается только то, что судья `tier` выбрал бы с этой правкой внутри разрешённого набора
 * задачи: команда не расширяет набор (расширение — `set-route`, фаза 5). Полная совместимость
 * переходника и маршрута (`compat`) судится на старте следующей сессии шага; до этого правка
 * лишь записана. `timing` записан как есть: идущая сессия не перезапускается здесь.
 */

type Scope = OverrideRow['scope'];
type Ids = { unitId: string | null; stepId: string | null };
const ENDED_STEP: ReadonlySet<TaskFoldState['steps'][string]['state']> = new Set([
  'done',
  'failed',
  'skipped',
]);

/** Куда смотрит правка: id уровня обязан существовать в этой задаче. */
function scopeIds(state: TaskFoldState, scope: Scope, scopeId: string): Ids | string {
  if (scope === 'task')
    return scopeId === state.taskId
      ? { unitId: null, stepId: null }
      : `scope task: ${scopeId} is not this task`;
  if (scope === 'unit')
    return state.units[scopeId]
      ? { unitId: scopeId, stepId: null }
      : `scope unit: no unit ${scopeId} in this task`;
  const step = state.steps[scopeId];
  if (!step) return `scope step: no step ${scopeId} in this task`;
  if (ENDED_STEP.has(step.state) || step.outcome)
    return `scope step: step ${scopeId} has already ended`;
  return { unitId: step.unitId, stepId: scopeId };
}

export interface OverrideLine {
  field: OverrideRow['field'];
  value: string | null;
}

/**
 * Ранг по тем же лестницам, что судья `tier` берёт для пола ревьюера (P35): один источник
 * сравнения, иначе команда предупреждала бы по одной шкале, а старт шага поднимал бы по другой.
 * Живёт здесь, а не в `policy/`: части не импортируют экономику друг друга (`core-parts-apart`).
 */
export function ladderRank(ladders: Readonly<Record<string, TierLadder>>): ModelRank {
  return (adapter, model) => modelRank(ladders[adapter], model);
}

/**
 * Идущие шаги ревью и автор каждого — по общему правилу `reviewAuthorOf` (то же у пола ревьюера
 * суда `tier`): предупреждение команды и подъём на старте шага смотрят на одного автора.
 */
function reviewAuthors(state: TaskFoldState): { review: string; author: string; unitId: string }[] {
  const out: { review: string; author: string; unitId: string }[] = [];
  for (const [id, step] of Object.entries(state.steps)) {
    if (step.stepKind !== 'review' || ENDED_STEP.has(step.state) || step.outcome) continue;
    const author = reviewAuthorOf(state, { stepId: id, unitId: step.unitId });
    if (author) out.push({ review: id, author, unitId: step.unitId });
  }
  return out;
}

/** Пары «ревью ← автор» с моделями, которые судья `tier` дал бы до и после правки. */
function reviewPairs(
  state: TaskFoldState,
  before: readonly OverrideRow[],
  after: readonly OverrideRow[],
): ReviewPair[] {
  const modelOf = (
    stepId: string,
    unitId: string,
    overrides: readonly OverrideRow[],
  ): StepModel => {
    const d = decideTier({
      taskId: state.taskId,
      unitId,
      stepId,
      stepModel: { tier: 'ceiling' },
      allowed: allowedRoutesOf(state),
      ceiling: state.created?.modelCeiling ?? null,
      overrides,
    });
    return d.ok
      ? { stepId, adapter: d.adapter, model: d.model }
      : { stepId, adapter: null, model: null };
  };
  return reviewAuthors(state).map(({ review, author, unitId }) => ({
    before: { review: modelOf(review, unitId, before), author: modelOf(author, unitId, before) },
    after: { review: modelOf(review, unitId, after), author: modelOf(author, unitId, after) },
  }));
}

/**
 * Общая дорога `set-model` и `set-cli`: суд уровня и набора, затем строки правки и исход.
 * Отказ называет каждое невыполненное условие разом.
 */
export async function applyOverride(
  task: LiveTask,
  cmdId: string,
  given: { scope: Scope; scopeId: string; timing: OverrideRow['timing'] },
  lines: readonly OverrideLine[],
  /** Только `set-model`: суд «ревьюер ниже автора» (06:8) с рангами переходника. */
  risk?: { rank: ModelRank | undefined },
): Promise<CommandResult> {
  const { state } = task;
  // Поля вида шире головы правки (`model`, `effort`) — в строку журнала идут только свои.
  const head = { scope: given.scope, scopeId: given.scopeId, timing: given.timing };
  if (!state.created || state.ended)
    return reject(
      task,
      cmdId,
      'state-conflict',
      state.ended ? `task already ended (${state.ended})` : 'task is not created yet',
    );
  const ids = scopeIds(state, head.scope, head.scopeId);
  if (typeof ids === 'string') return reject(task, cmdId, 'unknown-scope', ids);
  // Пробная свёртка: те же строки, что лягут в журнал, — судья видит правку как свершившуюся.
  const trial: OverrideRow[] = [
    ...state.overrides,
    ...lines.map((l, i) => ({ seq: state.seq + 1 + i, ...head, field: l.field, value: l.value })),
  ];
  const decision = decideTier({
    taskId: state.taskId,
    ...ids,
    stepModel: { tier: 'ceiling' },
    allowed: allowedRoutesOf(state),
    ceiling: state.created.modelCeiling,
    overrides: trial,
  });
  if (!decision.ok) return reject(task, cmdId, 'outside-allowed-set', decision.reasons.join('; '));
  // Риск судится до строк правки: пары «до» — по журналу без них, «после» — с пробными строками.
  const warnings = risk
    ? riskyOf({
        kind: 'set-model',
        pairs: reviewPairs(state, state.overrides, trial),
        rank: risk.rank,
      })
    : [];
  for (const l of lines)
    task.append({
      kind: 'override.set',
      actor: 'core',
      cmdId,
      data: { cmdId, ...head, field: l.field, value: l.value },
    });
  return applied(task, cmdId, {
    scope: `${head.scope}:${head.scopeId}`,
    adapter: decision.adapter,
    route: `${decision.route.kind}:${decision.route.id}`,
    model: decision.model ?? 'cli-default',
    timing: head.timing,
    // Без риска — исход без поля: строка журнала та же, что до этапа 7.
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

export const applySetModel: ApplyCommand = async (task, command, env) => {
  const f = command.fields as z.infer<(typeof COMMAND_FIELDS)['set-model']>;
  return applyOverride(
    task,
    command.cmdId,
    f,
    [
      { field: 'model', value: f.model },
      { field: 'effort', value: f.effort },
    ],
    { rank: env.modelRank },
  );
};

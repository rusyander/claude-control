import type { StepDef } from '@agentdeck/contracts/core/scenario';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
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

/** Пропуск шага, которого ещё не было: причина или `null` — шаг идёт. */
export function leadSkipOf(state: TaskFoldState, def: StepDef): string | null {
  const card = state.lead?.card;
  if (def.kind === 'intake' && card)
    return card.by === 'auto'
      ? 'intake card accepted automatically: structured acceptance, no forks'
      : 'intake card confirmed by the human';
  const cls = state.lead?.taskClass?.class;
  if (def.onlyFor && cls !== undefined && !def.onlyFor.includes(cls))
    return `task class ${cls}: step ${def.id} runs only for ${def.onlyFor.join(', ')}`;
  return null;
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
  const skip = leadSkipOf(state, def);
  if (skip === null) return null;
  return { kind: 'skip-step', unitId, stepDefId: def.id, round: 0, basis: 'core', reason: skip };
}

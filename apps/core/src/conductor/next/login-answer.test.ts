import { describe, expect, it } from 'vitest';
import type { AskRecord, StepRecord, TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { initialState } from '../../journal/reduce/reduce.ts';
import { loginAnswerAction } from './login-answer.ts';

/**
 * Суд ответа на вопрос потерянного входа (этап 12, P170) на чистой свёртке: правка поля после
 * потери входа значит, что ответ уже применён, — второй раз действие не выносится. Без этого
 * правила цикл переприменял бы ответ без конца (мутант гасился только таймаутом цикла).
 */

const TASK = '01a00000-0000-7000-8000-000000000001';
const STEP = '01a00000-0000-7000-8000-000000000002';
const ASK = '01a00000-0000-7000-8000-000000000003';

function stateWith(answer: string | undefined, overrides: TaskFoldState['overrides'] = []) {
  const state = initialState(TASK);
  const ask: AskRecord = {
    state: answer === undefined ? 'open' : 'answered',
    point: 4,
    source: 'login',
    dedupe: `login:${STEP}`,
    stepId: STEP,
    lateAnswer: false,
    defaultAction: null,
    ...(answer === undefined ? {} : { answer }),
  };
  return {
    ...state,
    loginLost: { [STEP]: { routeId: 'cli-login:claude', seq: 10 } },
    asks: { [ASK]: ask },
    overrides,
  } as TaskFoldState;
}

const att = { stepId: STEP, rec: {} as StepRecord };
const override = (seq: number, field: 'model' | 'adapter', value: string) => ({
  seq,
  scope: 'task' as const,
  scopeId: TASK,
  field,
  value,
  timing: 'now' as const,
});

describe('loginAnswerAction (stage 12, P170)', () => {
  it('cli: answer, no override after the loss → answered citing the ask', () => {
    expect(loginAnswerAction(stateWith('cli:codex'), att)).toEqual({
      kind: 'answered',
      stepId: STEP,
      askId: ASK,
      override: { field: 'adapter', value: 'codex' },
    });
  });

  it('an override of that field newer than the loss → nothing (already applied, never re-applied)', () => {
    const state = stateWith('cli:codex', [override(11, 'adapter', 'codex')]);
    expect(loginAnswerAction(state, att)).toBeNull();
  });

  it('a later human pick of the field wins: the answer does not overwrite it', () => {
    const state = stateWith('model:opus', [override(12, 'model', 'sonnet')]);
    expect(loginAnswerAction(state, att)).toBeNull();
  });

  it('an override OLDER than the loss, or of the other field, does not count as applied', () => {
    const state = stateWith('cli:codex', [
      override(5, 'adapter', 'claude'),
      override(11, 'model', 'sonnet'),
    ]);
    expect(loginAnswerAction(state, att)).toMatchObject({
      kind: 'answered',
      override: { field: 'adapter', value: 'codex' },
    });
  });

  it('no answer yet, or no loss on this step → nothing', () => {
    expect(loginAnswerAction(stateWith(undefined), att)).toBeNull();
    const noLoss = { ...stateWith('cli:codex'), loginLost: {} } as TaskFoldState;
    expect(loginAnswerAction(noLoss, att)).toBeNull();
  });
});

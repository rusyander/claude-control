import { describe, expect, it } from 'vitest';
import type { TaskClass } from '@agentdeck/contracts/core/lead';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { initialState } from '../../journal/reduce/reduce.ts';
import type { AskRecord, TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { INTAKE_ANSWERS } from '../intake/questions.ts';
import { PRESETS } from '../scenario/presets.ts';
import { leadGate, leadSkipOf } from './lead-gate.ts';

/**
 * Форма ведущего (W2-8, D22) у судьи `next`: класс S пропускает план (`onlyFor`), ревью идёт у
 * каждого класса; принятая карточка пропускает разбор; открытый вопрос приёма или класса держит
 * оценку; «остановить» без карточки кончает задачу.
 */

const TASK = newId();
const UNIT = newId();
const lead = PRESETS.find((p) => p.id === 'lead')!;
const def = (id: string): StepDef => lead.steps.find((s) => s.id === id)!;

function state(over: {
  cls?: TaskClass;
  card?: 'auto' | 'human';
  asks?: Record<string, AskRecord>;
}): TaskFoldState {
  const s = initialState(TASK);
  return {
    ...s,
    asks: over.asks ?? {},
    lead: {
      card: over.card ? { by: over.card, seq: 3 } : null,
      taskClass: over.cls ? { class: over.cls, seq: 4 } : null,
    },
  };
}

const ask = (dedupe: string, st: AskRecord['state'], answer?: string): AskRecord => ({
  state: st,
  point: 10,
  source: 'intake',
  dedupe,
  stepId: null,
  lateAnswer: false,
  ...(answer ? { answer } : {}),
});

describe('lead shape at next: class gates onlyFor steps', () => {
  it('an S task skips the plan with a reason naming the class', () => {
    const got = leadGate(state({ cls: 'S' }), def('plan'), UNIT);
    expect(got).toMatchObject({ kind: 'skip-step', stepDefId: 'plan', basis: 'core' });
    expect(got?.reason).toContain('task class S');
  });

  it('an S task keeps the review', () => {
    expect(leadGate(state({ cls: 'S' }), def('review'), UNIT)).toBeNull();
  });

  for (const cls of ['M', 'L', 'XL'] as const)
    it(`a ${cls} task runs the plan`, () => {
      expect(leadGate(state({ cls }), def('plan'), UNIT)).toBeNull();
    });

  it('an undecided class runs the full preset', () => {
    expect(leadSkipOf(state({}), def('plan'))).toBeNull();
  });
});

describe('lead shape at next: the intake card and the lead asks', () => {
  it('an accepted card skips the intake step', () => {
    expect(leadGate(state({ card: 'auto' }), def('intake'), UNIT)).toMatchObject({
      kind: 'skip-step',
      stepDefId: 'intake',
    });
  });

  it('no card: the intake step runs', () => {
    expect(leadGate(state({}), def('intake'), UNIT)).toBeNull();
  });

  it('an open intake ask holds the estimate', () => {
    const asks = { a: ask(`intake:${TASK}`, 'open') };
    expect(leadGate(state({ asks }), def('plan'), UNIT)).toMatchObject({ kind: 'wait' });
  });

  it('an open class ask holds the estimate', () => {
    const asks = { a: ask(`classify:${TASK}`, 'open') };
    expect(leadGate(state({ asks, cls: 'M' }), def('plan'), UNIT)?.kind).toBe('wait');
  });

  it('stop on the intake ask with no card fails the task', () => {
    const asks = { a: ask(`intake:${TASK}`, 'answered', INTAKE_ANSWERS.ru.stop) };
    expect(leadGate(state({ asks }), def('plan'), UNIT)).toMatchObject({ kind: 'fail-task' });
  });

  it('confirm with the card goes on', () => {
    const asks = { a: ask(`intake:${TASK}`, 'answered', INTAKE_ANSWERS.en.confirm) };
    expect(leadGate(state({ asks, card: 'human', cls: 'M' }), def('plan'), UNIT)).toBeNull();
  });
});

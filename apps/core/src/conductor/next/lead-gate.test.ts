import { describe, expect, it } from 'vitest';
import type { LeadProfile, TaskClass } from '@agentdeck/contracts/core/lead';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { initialState } from '../../journal/reduce/reduce.ts';
import type { AskRecord, TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { INTAKE_ANSWERS } from '../intake/questions.ts';
import { PRESETS } from '../scenario/presets.ts';
import type { AllowedRoute } from '../../economy/tier.types.ts';
import { CROSS_SKIP, crossAdapterOf, leadGate, leadSkipOf } from './lead-gate.ts';

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
  defaultAction: null,
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

describe('lead shape at next: onlyProfile steps follow the pinned lead profile (stage 12)', () => {
  const lead2 = PRESETS.find((p) => p.id === 'lead' && p.version === 2)!;
  const cross = lead2.steps.find((s) => s.id === 'review-cross')!;
  const pinned = (profile?: LeadProfile): TaskFoldState => ({
    ...state({ cls: 'M' }),
    created: (profile === undefined
      ? null
      : { lead: { profile } }) as unknown as TaskFoldState['created'],
  });

  it('max-quality pinned, the review ran on claude, codex allowed: the cross review runs', () => {
    expect(leadGate(crossState({}), cross, UNIT)).toBeNull();
  });

  for (const profile of ['economy', 'balanced'] as const)
    it(`${profile} pinned: the cross review is skipped, the reason names the profile`, () => {
      expect(leadGate(pinned(profile), cross, UNIT)).toMatchObject({
        kind: 'skip-step',
        stepDefId: 'review-cross',
        reason: `lead profile ${profile}: step review-cross runs only for max-quality`,
      });
    });

  it('no profile pinned (not a lead task): the cross review is skipped, fail-closed', () => {
    expect(leadSkipOf(pinned(), cross)).toBe(
      'lead profile none: step review-cross runs only for max-quality',
    );
  });

  it('a step without onlyProfile is not touched by the profile', () => {
    expect(leadGate(pinned('economy'), def('review'), UNIT)).toBeNull();
  });
});

type Route = AllowedRoute;
const ROUTE_OF = (adapter: string): Route => ({
  adapter,
  route: { kind: 'cli-login', id: `${adapter}-login` },
  modelPattern: '*',
});
const REVIEW_STEP = newId();

/**
 * Свёртка задачи «Максимума качества» после первого ревью: шаг `review` единицы `UNIT` вёл сессию
 * на `reviewAdapter` (нет — сессии не было); набор задачи — `allowed`; правки CLI — `overrides`.
 */
function crossState(over: {
  allowed?: string[];
  reviewAdapter?: string | null;
  overrides?: { scope: 'task' | 'unit'; value: string }[];
  routesSet?: string[];
}): TaskFoldState {
  const s = state({ cls: 'M' });
  const reviewAdapter = over.reviewAdapter === undefined ? 'claude' : over.reviewAdapter;
  return {
    ...s,
    created: {
      lead: { profile: 'max-quality' },
      allowedRoutes: (over.allowed ?? ['claude', 'codex']).map(ROUTE_OF),
    } as unknown as TaskFoldState['created'],
    routesSet: over.routesSet
      ? ({ allowedRoutes: over.routesSet.map(ROUTE_OF), seq: 9 } as TaskFoldState['routesSet'])
      : null,
    steps: {
      [REVIEW_STEP]: {
        unitId: UNIT,
        stepDefId: 'review',
        stepKind: 'review',
        round: 0,
        state: 'done',
        startedSeq: 7,
      } as unknown as TaskFoldState['steps'][string],
    },
    sessions:
      reviewAdapter === null
        ? {}
        : {
            s1: {
              stepId: REVIEW_STEP,
              adapter: reviewAdapter,
            } as unknown as TaskFoldState['sessions'][string],
          },
    overrides: (over.overrides ?? []).map((o, i) => ({
      seq: 20 + i,
      field: 'adapter',
      scope: o.scope,
      scopeId: o.scope === 'task' ? TASK : UNIT,
      value: o.value,
    })) as TaskFoldState['overrides'],
  };
}

describe('lead shape at next: the cross review needs an adapter other than the first reviewer (stage 12, P185)', () => {
  const lead2 = PRESETS.find((p) => p.id === 'lead' && p.version === 2)!;
  const cross = lead2.steps.find((s) => s.id === 'review-cross')!;
  const skipped = (first: string, why: string) =>
    `cross-review: ${why} ${first}, the first reviewer's (step review); step review-cross skipped, the change has one reviewer`;

  it('the first reviewer is named by the session of the latest review attempt in the unit', () => {
    expect(crossAdapterOf(crossState({ reviewAdapter: 'codex' }), UNIT, 'review')).toBe('codex');
    expect(crossAdapterOf(crossState({ reviewAdapter: null }), UNIT, 'review')).toBeNull();
    expect(crossAdapterOf(crossState({}), newId(), 'review')).toBeNull();
  });

  it('only the first reviewer adapter allowed: skipped, the reason starts with cross-review and names it', () => {
    expect(leadGate(crossState({ allowed: ['claude'] }), cross, UNIT)).toMatchObject({
      kind: 'skip-step',
      stepDefId: 'review-cross',
      basis: 'core',
      reason: skipped('claude', 'no allowed adapter other than'),
    });
    expect(
      leadSkipOf(crossState({ allowed: ['claude'] }), cross, UNIT)?.startsWith(CROSS_SKIP),
    ).toBe(true);
  });

  it('the set narrowed by set-route (routes.set) to the first reviewer adapter: skipped', () => {
    expect(leadSkipOf(crossState({ routesSet: ['claude'] }), cross, UNIT)).toBe(
      skipped('claude', 'no allowed adapter other than'),
    );
  });

  it('the step routes leave only the first reviewer adapter: skipped', () => {
    const narrowed = { ...cross, model: { ...cross.model, routes: [ROUTE_OF('claude')] } };
    expect(leadSkipOf(crossState({}), narrowed, UNIT)).toBe(
      skipped('claude', 'no allowed adapter other than'),
    );
  });

  it('the human pinned the task or unit CLI to the first reviewer adapter: skipped; pinned to another: runs', () => {
    for (const scope of ['task', 'unit'] as const)
      expect(leadSkipOf(crossState({ overrides: [{ scope, value: 'claude' }] }), cross, UNIT)).toBe(
        "cross-review: the human pinned adapter claude, the first reviewer's (step review); step review-cross skipped, the change has one reviewer",
      );
    expect(
      leadSkipOf(crossState({ overrides: [{ scope: 'unit', value: 'codex' }] }), cross, UNIT),
    ).toBeNull();
  });

  it('the review ran no session: nothing to cross-check, skipped with the reason', () => {
    expect(leadSkipOf(crossState({ reviewAdapter: null }), cross, UNIT)).toBe(
      'cross-review: step review ran no session, nothing to cross-check; step review-cross skipped, no second reviewer',
    );
  });

  it('balanced keeps the profile reason, never the cross one', () => {
    const balanced = {
      ...crossState({ allowed: ['claude'] }),
      created: { lead: { profile: 'balanced' }, allowedRoutes: [ROUTE_OF('claude')] },
    } as unknown as TaskFoldState;
    expect(leadSkipOf(balanced, cross, UNIT)).toBe(
      'lead profile balanced: step review-cross runs only for max-quality',
    );
  });

  it('a step without crossOf is never judged by the adapter rule', () => {
    expect(leadSkipOf(crossState({ allowed: ['claude'] }), def('review'), UNIT)).toBeNull();
  });
});

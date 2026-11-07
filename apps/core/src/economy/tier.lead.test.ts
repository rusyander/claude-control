import type { LearnedRaise } from '@agentdeck/contracts/core/economy';
import { describe, expect, it } from 'vitest';
import { decideTier } from './tier.ts';
import type { AllowedRoute, TierEscalation, TierInput, TierLadder } from './tier.types.ts';

/**
 * @covers economy/tier.ts economy/tier-raise.ts economy/tier-ladder.ts
 * Суд `tier` этапа 11 (W2-10, D7, D21, F1): строка роли профиля заменяет уровень сценария, `max`
 * срезается и называется, Fable автоматика не выбирает никогда (потолок — min(потолок задачи,
 * `autoCeiling`)), эскалация — ровно одна ступень вверх с причиной, у потолка — та же ступень.
 */

const TASK = '01920000-0000-7000-8000-0000000000a1';
const UNIT = '01920000-0000-7000-8000-0000000000b1';
const STEP = '01920000-0000-7000-8000-0000000000c1';
const PRIOR = '01920000-0000-7000-8000-0000000000c0';

const ANY: AllowedRoute = {
  adapter: 'claude',
  route: { kind: 'cli-login', id: 'cli-login-claude' },
  modelPattern: '*',
};

/** Лестница Claude из фактов запуска: Fable выше Opus, автоматика — до Opus. */
const LADDER: TierLadder = {
  models: ['haiku', 'sonnet', 'opus', 'fable'],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  autoCeiling: 'opus',
};

const input = (over: Partial<TierInput> = {}): TierInput => ({
  taskId: TASK,
  unitId: UNIT,
  stepId: STEP,
  stepModel: { tier: 'ceiling' },
  allowed: [ANY],
  ceiling: 'opus',
  overrides: [],
  stepKind: 'work',
  ladders: { claude: LADDER },
  ...over,
});

const red = (model: string, effort: string): TierEscalation => ({
  cause: { stepId: PRIOR, seq: 41, recordId: 'rec.0', why: 'red-check' },
  from: { model, effort },
});

describe('stage 11 tier: role rows, effort clamp, Fable never auto, escalation', () => {
  it('a profile row overrides the scenario tier: mechanical lowered with the row effort, source profile', () => {
    const got = decideTier(
      input({
        role: 'mechanical',
        roleRow: { row: { tier: 'lower-if-mechanical', effort: 'high' }, source: 'profile' },
      }),
    );
    expect(got).toMatchObject({
      ok: true,
      model: 'sonnet',
      effort: 'high',
      applied: 'lowered',
      role: 'mechanical',
      roleSource: 'profile',
      sources: { effort: 'profile' },
    });
  });

  it('without a row the scenario tier decides (ceiling), role is the step-kind default', () => {
    const got = decideTier(input({ stepModel: { tier: 'ceiling', effort: 'medium' } }));
    expect(got).toMatchObject({
      ok: true,
      model: 'opus',
      effort: 'medium',
      roleSource: 'scenario',
    });
  });

  it('a row asking effort max is clamped below max and named', () => {
    const got = decideTier(
      input({
        role: 'implement',
        roleRow: { row: { tier: 'ceiling', effort: 'max' }, source: 'project' },
      }),
    );
    expect(got).toMatchObject({ ok: true, effort: 'xhigh' });
    expect(got.reasons.join('; ')).toMatch(/max/);
  });

  it('Fable is never chosen by automation: an escalation from opus·xhigh under a fable ceiling stays, «потолок»', () => {
    const got = decideTier(input({ ceiling: 'fable', escalation: red('opus', 'xhigh') }));
    expect(got).toMatchObject({ ok: true, model: 'opus', effort: 'xhigh' });
    expect(got.ok && got.escalation).toEqual({
      cause: red('opus', 'xhigh').cause,
      atCeiling: true,
    });
    expect(got.reasons.join('; ')).toMatch(/потолок/);
  });

  it('Fable is never chosen by a learned promotion either', () => {
    const raise: LearnedRaise = { rungs: 3, evidence: ['s1'], rate: 0.5, samples: 8, basis: 'key' };
    const got = decideTier(
      input({
        ceiling: 'fable',
        project: 'r1',
        stepModel: { tier: 'ceiling', effort: 'xhigh' },
        roleRow: { row: { tier: 'lower-if-mechanical', effort: 'xhigh' }, source: 'profile' },
        role: 'mechanical',
        learnedRaise: () => raise,
      }),
    );
    expect(got.ok && got.model).not.toBe('fable');
  });

  it('escalation: exactly one rung up — effort first, then the next model at the role effort', () => {
    const effort = decideTier(input({ escalation: red('sonnet', 'high') }));
    expect(effort).toMatchObject({
      ok: true,
      model: 'sonnet',
      effort: 'xhigh',
      roleSource: 'escalation',
      sources: { model: 'escalation', effort: 'escalation' },
    });
    const model = decideTier(
      input({
        escalation: red('sonnet', 'xhigh'),
        roleRow: { row: { tier: 'ceiling', effort: 'high' }, source: 'profile' },
      }),
    );
    expect(model).toMatchObject({ ok: true, model: 'opus', effort: 'high' });
    expect(model.ok && model.escalation?.atCeiling).toBe(false);
  });

  it('a rung held by the route model pattern names the pattern, not the auto ceiling; at the cap it names the auto ceiling', () => {
    // Шаблон пускает haiku и fable (потолок задачи), но не sonnet и opus — ступени под потолком
    // автоматики (opus): держит шаблон, а не потолок.
    const narrow: AllowedRoute = { ...ANY, modelPattern: '*a*' };
    const held = decideTier(
      input({ allowed: [narrow], ceiling: 'fable', escalation: red('haiku', 'xhigh') }),
    );
    expect(held).toMatchObject({ ok: true, model: 'haiku', effort: 'xhigh' });
    expect(held.ok && held.escalation?.atCeiling).toBe(true);
    const why = held.reasons.join('; ');
    expect(why).toMatch(
      /haiku·xhigh: sonnet, opus above it under the auto ceiling are outside the route model pattern/,
    );
    expect(why).not.toMatch(/is the auto ceiling/);
    const capped = decideTier(input({ ceiling: 'fable', escalation: red('opus', 'xhigh') }));
    expect(capped.reasons.join('; ')).toMatch(/opus·xhigh is the auto ceiling/);
  });

  it('escalation keeps its cause (step, seq, record) on the decision', () => {
    const got = decideTier(input({ escalation: red('haiku', 'low') }));
    expect(got.ok && got.escalation?.cause).toEqual({
      stepId: PRIOR,
      seq: 41,
      recordId: 'rec.0',
      why: 'red-check',
    });
    expect(got.reasons.join('; ')).toMatch(/record rec\.0/);
  });
});

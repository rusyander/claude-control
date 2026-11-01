import { describe, expect, it } from 'vitest';
import type { Scenario, StepDef } from '@agentdeck/contracts/core/scenario';
import {
  chained,
  draftFrom,
  draftProblems,
  insertStepAfter,
  isChain,
  moveStep,
  newStep,
  nextVersion,
  orderedSteps,
  parseRef,
  removeStepAt,
  scenarioOf,
  taskScenarioOf,
  uniqueStepId,
  withKind,
} from './scenarioDraft';
import { knownRefusal, refusalOf } from './refusalOf';

const step = (id: string, after: string[] = [], kind: StepDef['kind'] = 'work'): StepDef => ({
  ...newStep(kind, id, []),
  id,
  after,
});

const FEATURE: Scenario = {
  id: 'feature',
  version: 1,
  title: 'Новая возможность',
  steps: chained([
    step('intake', [], 'intake'),
    step('work'),
    step('final-gate', [], 'final-gate'),
    step('publish', [], 'publish'),
  ]),
};

const ids = (steps: readonly StepDef[]) => steps.map((s) => s.id);
const afters = (steps: readonly StepDef[]) => steps.map((s) => s.after.join(','));

describe('scenario draft: chain by screen order', () => {
  it('insert, remove and move keep after = previous step', () => {
    const base = FEATURE.steps;
    const added = insertStepAfter(base, 0, step('plan', [], 'plan'));
    expect(ids(added)).toEqual(['intake', 'plan', 'work', 'final-gate', 'publish']);
    expect(afters(added)).toEqual(['', 'intake', 'plan', 'work', 'final-gate']);
    const top = insertStepAfter(base, -1, step('research', [], 'research'));
    expect(afters(top).slice(0, 2)).toEqual(['', 'research']);
    expect(afters(removeStepAt(added, 0))).toEqual(['', 'plan', 'work', 'final-gate']);
  });

  it('move uses the shared slot rule: after itself or before itself is no move', () => {
    const base = FEATURE.steps;
    expect(ids(moveStep(base, 0, 1))).toEqual(['work', 'intake', 'final-gate', 'publish']);
    expect(ids(moveStep(base, 3, -1))).toEqual(['publish', 'intake', 'work', 'final-gate']);
    expect(ids(moveStep(base, 1, 1))).toEqual(ids(base));
    expect(ids(moveStep(base, 1, 0))).toEqual(ids(base));
    expect(afters(moveStep(base, 0, 1))).toEqual(['', 'work', 'intake', 'final-gate']);
  });

  it('a branching scenario is shown in dependency order and is not a chain', () => {
    const branched = [step('b', ['a']), step('a'), step('c', ['a'])];
    expect(ids(orderedSteps(branched))).toEqual(['a', 'b', 'c']);
    expect(isChain(branched)).toBe(false);
    expect(isChain(FEATURE.steps)).toBe(true);
  });
});

describe('scenario draft: ids, kinds, versions', () => {
  it('step ids stay unique and kind-only fields follow the kind', () => {
    expect(uniqueStepId('work', ['work', 'work-2'])).toBe('work-3');
    expect(uniqueStepId('Не слаг', [])).toBe('step');
    const ask = withKind(step('w'), 'ask-human');
    expect(ask.ask?.options.length).toBeGreaterThanOrEqual(2);
    expect(withKind(ask, 'review').ask).toBeUndefined();
  });

  it('a preset base gets an own id and presetOf; the version is always latest + 1', () => {
    const library: Scenario[] = [
      { ...FEATURE, id: 'feature-own', version: 1 },
      { ...FEATURE, id: 'feature-own', version: 4 },
    ];
    const draft = draftFrom(FEATURE, library);
    expect(draft.presetOf).toEqual({ id: 'feature', version: 1 });
    expect(draft.id).toBe('feature-own-2');
    expect(nextVersion(library, 'feature-own')).toBe(5);
    expect(scenarioOf({ ...draft, id: 'feature-own' }, library).version).toBe(5);
    expect(scenarioOf(draft, library).version).toBe(1);
  });
});

describe('scenario draft: problems before the request', () => {
  it('the strict contract schema and scenarioProblems both speak; a preset id is named', () => {
    const ok = scenarioOf(draftFrom(FEATURE, []), []);
    expect(draftProblems(ok)).toEqual([]);
    const blank = { ...ok, steps: ok.steps.map((s, i) => (i === 1 ? { ...s, title: '' } : s)) };
    expect(draftProblems(blank).map((p) => p.path)).toEqual(['steps.1.title']);
    const ungated = { ...ok, steps: chained(ok.steps.filter((s) => s.kind !== 'final-gate')) };
    expect(draftProblems(ungated).map((p) => p.message)).toEqual([
      'publish: publish without a final-gate before it',
    ]);
    expect(draftProblems({ ...ok, id: 'bug-fix' })[0]?.path).toBe('id');
  });
});

describe('core refusal of a save or an edit', () => {
  it('reads code, reason, problems and the next version from the axios error', () => {
    const taken = refusalOf({
      response: { status: 409, data: { code: 'version-taken', error: 'taken', next: 3 } },
    });
    expect(taken).toEqual({
      status: 409,
      code: 'version-taken',
      reason: 'taken',
      problems: [],
      next: 3,
    });
    const rejected = refusalOf({
      response: { status: 409, data: { status: 'rejected', code: 'state-conflict', reason: 'r' } },
    });
    expect([rejected?.code, rejected?.reason]).toEqual(['state-conflict', 'r']);
    expect(refusalOf(new Error('network'))).toBeUndefined();
    expect(knownRefusal('signature-required')).toBe('signature-required');
    expect(knownRefusal('something-else')).toBeUndefined();
  });
});

describe('scenario draft: refs and the task view', () => {
  it('parses id@v and reads the latest task scenario (pending wins)', () => {
    expect(parseRef('team-flow@3')).toEqual({ id: 'team-flow', version: 3 });
    expect(parseRef('Bad@x')).toBeUndefined();
    const ref = { id: 'feature', version: 1 };
    expect(taskScenarioOf({ ref, pending: null })).toEqual({
      current: ref,
      pending: false,
    });
    const to = { id: 'feature-own', version: 2 };
    expect(taskScenarioOf({ ref, pending: { to, applyNow: false } })).toEqual({
      current: to,
      pending: true,
    });
    expect(taskScenarioOf(null)).toBeUndefined();
  });
});

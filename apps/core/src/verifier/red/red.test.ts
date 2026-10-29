import type { CheckRecord, NoVerdictReason } from '@agentdeck/contracts/core/records';
import { describe, expect, it } from 'vitest';
import { fixtureRecord, red } from './__fixtures__/record.ts';
import { classifyRed } from './classify.ts';
import { decideRedBefore } from './red-before.ts';
import type { RedInput } from './red.types.ts';

/**
 * Класс красного (04:78-81, P75) и ворота «красный до» (04:68-71, P94) — таблицы. Строка таблицы —
 * одно правило спецификации; мутант каждой ветки обязан покраснеть хоть одной строкой.
 */

const T = { file: 'apps/app/a.test.ts', name: 'a > works' };
const LEGACY = { file: 'apps/app/old.test.ts', name: 'old > legacy' };
const input = (over: Partial<RedInput>): RedInput => ({
  final: red([T]),
  base: null,
  inChangedClosure: true,
  changed: ['apps/app/a.ts', 'apps/app/a.test.ts'],
  quarantined: [],
  scenarioRequired: false,
  ...over,
});
const cls = (over: Partial<RedInput>): string => {
  const out = classifyRed(input(over));
  return out.kind === 'class' ? out.red : out.kind;
};
const noVerdict = (reason: NoVerdictReason): CheckRecord =>
  fixtureRecord({ verdict: { kind: 'no-verdict', reason }, exit: null });

describe('verifier/red classifyRed (04:78-81, P75)', () => {
  it.each([
    ['red of a changed test in the changed closure on the final tree → defect', {}, 'defect'],
    [
      'red in the changed closure, test file itself unchanged, base not run → need-base',
      { changed: ['apps/app/a.ts'] },
      'need-base',
    ],
    [
      'same, base green → defect (the change broke an untouched test)',
      { changed: ['apps/app/a.ts'], base: fixtureRecord() },
      'defect',
    ],
    [
      'same, the test red on base too → stale (legacy red, not our work)',
      { changed: ['apps/app/a.ts'], base: red([T]) },
      'stale',
    ],
    [
      'red on base too, test file outside the change → stale (final report only)',
      { final: red([LEGACY]), base: red([LEGACY]) },
      'stale',
    ],
    [
      'same base red, but the scenario names the check required → defect',
      { final: red([LEGACY]), base: red([LEGACY]), scenarioRequired: true },
      'defect',
    ],
    [
      'red outside the change, base not run yet → need-base (doubt → run, never stale)',
      { final: red([LEGACY]) },
      'need-base',
    ],
    [
      'red outside the change, base green → defect (the task brought it)',
      { final: red([LEGACY]), base: fixtureRecord() },
      'defect',
    ],
    [
      'red outside the change, base red on another test → defect',
      { final: red([LEGACY]), base: red([T]) },
      'defect',
    ],
    [
      'unit closure untouched, unattributable red, base unattributable red → stale',
      { final: red([]), base: red([]), inChangedClosure: false },
      'stale',
    ],
    ['unattributable red in the changed closure → defect', { final: red([]) }, 'defect'],
    [
      'quarantined test red on final, green on base → defect',
      { quarantined: [{ test: T.name }], base: fixtureRecord() },
      'defect',
    ],
    [
      'quarantined test red on final and on base → flaky (quarantine holds)',
      { quarantined: [{ test: T.name, file: T.file }], base: red([T]) },
      'flaky',
    ],
    [
      'quarantine names the same test path in ANOTHER file → not quarantined; changed test red on base too → defect',
      { quarantined: [{ test: T.name, file: 'apps/other/a.test.ts' }], base: red([T]) },
      'defect',
    ],
    [
      'quarantined test red, base not run → need-base',
      { quarantined: [{ test: T.name }] },
      'need-base',
    ],
    [
      'runner prints the changed test file relative to its own root (monorepo cwd) → still the changed file → defect, never stale',
      {
        final: red([{ file: 'src/a.test.ts', name: T.name }]),
        base: red([{ file: 'src/a.test.ts', name: T.name }]),
        changed: ['apps/app/src/a.test.ts'],
      },
      'defect',
    ],
    [
      'runner prints the changed test file with backslashes → defect',
      {
        final: red([{ file: 'apps\\app\\a.test.ts', name: T.name }]),
        base: red([{ file: 'apps\\app\\a.test.ts', name: T.name }]),
      },
      'defect',
    ],
    [
      'absolute failing path that matches no changed file (unknown root) → not provably outside → defect',
      {
        final: red([{ file: 'C:/elsewhere/old.test.ts', name: LEGACY.name }]),
        base: red([{ file: 'C:/elsewhere/old.test.ts', name: LEGACY.name }]),
      },
      'defect',
    ],
    [
      'pass-flaky → flaky',
      { final: fixtureRecord({ verdict: { kind: 'pass-flaky', retries: ['r.1'] } }) },
      'flaky',
    ],
    ['no-verdict(stand) → stand', { final: noVerdict('stand') }, 'stand'],
    ['no-verdict(env) → env', { final: noVerdict('env') }, 'env'],
    ['no-verdict(engine) → env', { final: noVerdict('engine') }, 'env'],
    [
      'no-verdict(selection) → stale (the binding names no test)',
      { final: noVerdict('selection') },
      'stale',
    ],
    ['aborted is not red → rerun', { final: noVerdict('aborted') }, 'rerun'],
    [
      'requested-but-absent → defect',
      { final: fixtureRecord({ verdict: { kind: 'fail', reason: 'absent' } }) },
      'defect',
    ],
  ] as [string, Partial<RedInput>, string][])('%s', (_name, over, expected) => {
    expect(cls(over)).toBe(expected);
  });

  it('a green record is not classified', () => {
    expect(() => classifyRed(input({ final: fixtureRecord() }))).toThrow(/зелёная/);
  });
});

describe('verifier/red decideRedBefore (04:68-71, P94)', () => {
  const TEST = 'sum > adds';
  const assertionRed = red([{ name: TEST }]);
  it.each([
    [
      'red on base on its own assertion, green after → proven',
      assertionRed,
      fixtureRecord(),
      'proven',
    ],
    [
      'green on base → the test does not catch the bug',
      fixtureRecord(),
      fixtureRecord(),
      'green-on-base',
    ],
    [
      'red on base with no parsed names (collection/import error) → no-verdict-engine, gate open',
      red([]),
      fixtureRecord(),
      'no-verdict-engine',
    ],
    [
      'red on base on ANOTHER test → no-verdict-engine',
      red([{ name: 'other > test' }]),
      fixtureRecord(),
      'no-verdict-engine',
    ],
    [
      'base no-verdict(engine) → no-verdict-engine',
      noVerdict('engine'),
      fixtureRecord(),
      'no-verdict-engine',
    ],
    [
      'red before and still red after → red-after',
      assertionRed,
      red([{ name: TEST }]),
      'red-after',
    ],
    [
      'final without verdict → no proof of green-after',
      assertionRed,
      noVerdict('stand'),
      'no-verdict-engine',
    ],
    [
      'red on base of a DIFFERENT test sharing the leaf path (legacy > sum > adds) → no-verdict-engine',
      red([{ name: `legacy > ${TEST}` }]),
      fixtureRecord(),
      'no-verdict-engine',
    ],
    [
      'final green whose passing list names other tests, not this one → no proof of green-after',
      assertionRed,
      fixtureRecord({ passing: [{ name: 'other > test' }] }),
      'no-verdict-engine',
    ],
    [
      'final green whose passing list names the test → proven',
      assertionRed,
      fixtureRecord({ passing: [{ file: 'src/sum.test.ts', name: TEST }] }),
      'proven',
    ],
  ] as [string, CheckRecord, CheckRecord, string][])('%s', (_name, base, final, expected) => {
    const out = decideRedBefore(TEST, base, final);
    expect(out).toEqual({ test: TEST, base: base.id, final: final.id, outcome: expected });
  });

  it('the test file, when both sides know it, must match: the same path red in another file is not red-before', () => {
    const elsewhere = red([{ file: 'src/other.test.ts', name: TEST }]);
    expect(decideRedBefore(TEST, elsewhere, fixtureRecord(), 'src/sum.test.ts').outcome).toBe(
      'no-verdict-engine',
    );
    const own = red([{ file: 'apps\\web\\src\\sum.test.ts', name: TEST }]);
    expect(decideRedBefore(TEST, own, fixtureRecord(), 'src/sum.test.ts').outcome).toBe('proven');
  });
});

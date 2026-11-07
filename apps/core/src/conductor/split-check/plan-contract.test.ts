import { describe, expect, it } from 'vitest';
import { decideSplit } from './split-check.ts';
import type { SplitCheckInput, SplitPlanContract, SplitUnit } from './split-check.types.ts';

/**
 * Договор плана ведущего (этап 11, D6, P137) поверх P39: у каждого куска решаемая проверка,
 * годная роль, критерии кусков покрывают все открытые требования, входы — от кусков-зависимостей,
 * общий интерфейс — через кусок-каркас `implement`, механика без полной спецификации понижена до
 * `implement`. Все пробелы — в одном отказе. Без договора правила плана не действуют.
 */

const R1 = '01920000-0000-7000-8000-0000000000e1';
const R2 = '01920000-0000-7000-8000-0000000000e2';
const CHECKS = new Set(['r1:test', 'r1:lint']);

const plan = (open: string[] = [R1]): SplitPlanContract => ({
  resolvesCheck: (repoKey, checkId) => CHECKS.has(`${repoKey}:${checkId}`),
  openRequirements: open,
});

const piece = (name: string, over: Partial<SplitUnit> = {}): SplitUnit => ({
  name,
  repoKey: 'r1',
  ownedPaths: [`${name}/**`],
  deps: [],
  contract: false,
  estimate: { minutes: null, tokens: null },
  check: 'test',
  role: 'implement',
  acRefs: [R1],
  ...over,
});

const input = (units: SplitUnit[], over: Partial<SplitCheckInput> = {}): SplitCheckInput => ({
  units,
  deliverable: { kind: 'change' },
  capacity: { slots: 4, minutes: null },
  foldCase: false,
  plan: plan(),
  ...over,
});

const codes = (i: SplitCheckInput): string[] => {
  const d = decideSplit(i);
  return d.verdict === 'refused' ? d.problems.map((p) => p.code).sort() : [];
};

const FULL_SPEC = { files: ['b/x.ts'], interface: 'export function x(): number', check: 'test' };

describe('split check: lead plan contract', () => {
  it('D6 table: one row per rule, every gap of a plan in one refusal', () => {
    const rows: { name: string; in: SplitCheckInput; codes: string[] }[] = [
      { name: 'complete plan', in: input([piece('a'), piece('b', { deps: ['a'] })]), codes: [] },
      {
        name: 'piece without a check',
        in: input([piece('a'), piece('b', { check: undefined })]),
        codes: ['no-check'],
      },
      {
        name: 'check the registry does not resolve',
        in: input([piece('a'), piece('b', { check: 'e2e' })]),
        codes: ['unknown-check'],
      },
      {
        name: 'role that is not a piece role',
        in: input([piece('a'), piece('b', { role: 'recon' })]),
        codes: ['bad-role'],
      },
      {
        name: 'open requirement no piece covers',
        in: input([piece('a'), piece('b')], { plan: plan([R1, R2]) }),
        codes: ['uncovered-requirement'],
      },
      {
        name: 'input from a piece that is not a dep',
        in: input([piece('a'), piece('b', { inputs: [{ from: 'a', iface: 'A' }] })]),
        codes: ['input-not-dep'],
      },
      {
        name: 'input from an unknown piece',
        in: input([piece('a'), piece('b', { inputs: [{ from: 'zz', iface: 'A' }] })]),
        codes: ['input-not-dep'],
      },
      {
        name: 'shared interface without an implement skeleton',
        in: input([
          piece('a', { role: 'mechanical', spec: FULL_SPEC }),
          piece('b', { deps: ['a'], inputs: [{ from: 'a', iface: 'A' }] }),
          piece('c', { deps: ['a'], inputs: [{ from: 'a', iface: 'A' }] }),
        ]),
        codes: ['no-skeleton'],
      },
      {
        name: 'shared interface through an implement skeleton',
        in: input([
          piece('a'),
          piece('b', { deps: ['a'], inputs: [{ from: 'a', iface: 'A' }] }),
          piece('c', { deps: ['a'], inputs: [{ from: 'a', iface: 'A' }] }),
        ]),
        codes: [],
      },
      {
        name: 'solo piece is judged too',
        in: input([piece('a', { check: undefined, acRefs: [] })]),
        codes: ['no-check', 'uncovered-requirement'],
      },
    ];
    for (const row of rows)
      expect({ row: row.name, codes: codes(row.in) }).toEqual({
        row: row.name,
        codes: row.codes,
      });
  });

  it('D6 a plan with three gaps is ONE refusal naming all three; the fixed plan is accepted', () => {
    const gaps = input([
      piece('a', { check: undefined }),
      piece('b', { role: 'plan', deps: ['a'] }),
      piece('c', { inputs: [{ from: 'b', iface: 'B' }] }),
    ]);
    const refused = decideSplit(gaps);
    expect(refused.verdict).toBe('refused');
    expect(codes(gaps)).toEqual(['bad-role', 'input-not-dep', 'no-check']);
    expect(refused.reasons).toHaveLength(3);
    expect(refused.reasons.join(' | ')).toMatch(/no-check: a .*bad-role: b .*input-not-dep: c/);
    const fixed = decideSplit(
      input([
        piece('a'),
        piece('b', { deps: ['a'] }),
        piece('c', { deps: ['b'], inputs: [{ from: 'b', iface: 'B' }] }),
      ]),
    );
    expect(fixed).toMatchObject({
      verdict: 'accepted',
      roles: { a: 'implement', b: 'implement', c: 'implement' },
      demoted: [],
    });
  });

  it('D6 mechanical without a complete spec runs as implement, the reason names what is missing', () => {
    const d = decideSplit(
      input([
        piece('a', { role: 'mechanical', spec: { files: ['a/x.ts'] } }),
        piece('b', { role: 'mechanical', spec: FULL_SPEC }),
        piece('c', { role: undefined }),
      ]),
    );
    expect(d).toMatchObject({
      verdict: 'accepted',
      roles: { a: 'implement', b: 'mechanical', c: 'implement' },
      demoted: [{ unit: 'a', missing: ['interface', 'check'] }],
    });
    expect(d.reasons).toContain(
      'a: mechanical without a complete spec (interface, check) → implement',
    );
  });

  it('D6 without the plan contract the lead rules are not judged (P39 only)', () => {
    const d = decideSplit(
      input([piece('a', { check: undefined, role: 'recon' }), piece('b')], {
        plan: undefined,
      }),
    );
    expect(d.verdict).toBe('accepted');
    expect(d).not.toHaveProperty('roles');
  });
});

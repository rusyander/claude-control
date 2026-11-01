import { describe, expect, it } from 'vitest';
import { decideReady, readyInputsHash, readyJudge, refusalUnmet } from './ready.ts';
import type { PublishReadyInput } from './ready.types.ts';

/** Готовность к публикации (05 §Readiness): один отказ со ВСЕМИ условиями, память по хешу входа. */

const clean = (over: Partial<PublishReadyInput> = {}): PublishReadyInput => ({
  unitId: 'u1',
  compositionId: 'c1',
  compositionTreeFp: 'T1',
  outgoingTreeFp: 'T1',
  baseOnServer: { ref: 'refs/heads/main', sha: 'b'.repeat(40) },
  mergeTree: 'clean',
  requirements: 'met',
  coverage: { policy: 'refuse', gaps: [] },
  sieves: [],
  texts: [{ kind: 'commit', verdict: 'pass' }],
  openHumanPoints: [],
  ...over,
});

describe('publisher ready', () => {
  it('everything met: allow with the input hash', () => {
    const d = decideReady(clean());
    expect(d).toEqual({ kind: 'allow', inputsHash: readyInputsHash(clean()) });
  });

  it('one refusal lists every unmet condition, not only the first', () => {
    const d = decideReady(
      clean({
        requirements: { unmet: ['R1', 'R2'] },
        coverage: { policy: 'refuse', gaps: ['src/a.ts'] },
        sieves: [{ sieve: 'secret', file: 'b.ts', detail: 'token' }],
        texts: [{ kind: 'mr-body', verdict: 'refused' }],
      }),
    );
    expect(d.kind).toBe('refuse');
    if (d.kind !== 'refuse') return;
    expect(d.unmet.map((u) => `${u.code}:${u.subject}`)).toEqual([
      'requirements:R1',
      'requirements:R2',
      'coverage-gap:src/a.ts',
      'sieve:secret:b.ts',
      'text:mr-body',
    ]);
    expect(d.next).toBe('fix-step');
    expect(refusalUnmet(d)).toHaveLength(5);
  });

  it('the tree is compared, not the sha: a different outgoing tree refuses with regate', () => {
    expect(decideReady(clean({ outgoingTreeFp: 'T2' }))).toMatchObject({
      kind: 'refuse',
      next: 'regate',
      unmet: [{ code: 'composition-mismatch', subject: 'c1' }],
    });
  });

  it('next priority: an open human point beats a forge outage beats a conflict', () => {
    const all = clean({
      openHumanPoints: [3],
      baseOnServer: { unknown: 'timeout' },
      mergeTree: 'conflict',
      requirements: { unmet: ['R1'] },
    });
    expect(decideReady(all)).toMatchObject({ next: 'ask' });
    expect(decideReady({ ...all, openHumanPoints: [] })).toMatchObject({ next: 'wait-forge' });
    expect(
      decideReady({ ...all, openHumanPoints: [], baseOnServer: clean().baseOnServer }),
    ).toMatchObject({ next: 'resolve-conflict' });
  });

  it('coverage gaps only refuse under the refuse policy; an unknown coverage refuses', () => {
    expect(decideReady(clean({ coverage: { policy: 'warn', gaps: ['x'] } })).kind).toBe('allow');
    expect(
      decideReady(clean({ coverage: { policy: 'refuse', gaps: { unknown: 'no lcov' } } })),
    ).toMatchObject({ unmet: [{ code: 'coverage-gap', next: 'no lcov' }] });
  });

  it('memo: the same input is decided once; a changed input is decided again', () => {
    const judge = readyJudge();
    const a = judge.decide(clean());
    const b = judge.decide({ ...clean(), openHumanPoints: [] });
    expect(b).toBe(a);
    expect(judge.computed).toBe(1);
    judge.decide(clean({ openHumanPoints: [1] }));
    expect(judge.computed).toBe(2);
  });

  it('the input hash ignores field order', () => {
    const x = clean();
    const reordered = Object.fromEntries(Object.entries(x).reverse()) as PublishReadyInput;
    expect(readyInputsHash(reordered)).toBe(readyInputsHash(x));
  });
});

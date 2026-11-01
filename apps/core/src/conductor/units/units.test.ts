import { describe, expect, it } from 'vitest';
import { decideSplit, type SplitUnit } from '../split-check/index.ts';
import { unitBaseOf, unitsOfSplit } from './index.ts';

/**
 * Единицы деления (02:73-74, G19): `after` по рёбрам проверки, порядок создания = порядок
 * проверки; основа ветки — последний предшественник того же репозитория, иначе приколотая база.
 */

const u = (name: string, repoKey: string, over: Partial<SplitUnit> = {}): SplitUnit => ({
  name,
  repoKey,
  ownedPaths: [`${name}/**`],
  deps: [],
  contract: false,
  estimate: { minutes: null, tokens: null },
  ...over,
});

const REPOS = [
  { repoKey: 'svc', path: '/r/svc', baseRef: 'a'.repeat(40) },
  { repoKey: 'app', path: '/r/app', baseRef: 'b'.repeat(40) },
];

describe('units', () => {
  it('G19 split units carry after-edges in check order; base is the last same-repo predecessor else the pinned base', () => {
    const units = [
      u('page', 'app'),
      u('impl', 'svc', { deps: ['contract'] }),
      u('more', 'svc', { deps: ['impl', 'contract'] }),
      u('contract', 'svc', { contract: true }),
    ];
    const decision = decideSplit({
      units,
      deliverable: { kind: 'change' },
      capacity: { slots: 4, minutes: null },
      foldCase: false,
    });
    if (decision.verdict !== 'accepted') throw new Error(decision.reasons.join('; '));
    let n = 0;
    const made = unitsOfSplit(
      decision,
      units,
      'split-1',
      () => `0192000${++n}-0000-7000-8000-000000000000`,
    );
    expect(made.map((m) => m.name)).toEqual(decision.order);
    const id = (name: string): string => made.find((m) => m.name === name)?.unitId as string;
    const of = (name: string) => made.find((m) => m.name === name) as (typeof made)[number];
    expect(of('page').after).toEqual([id('contract')]);
    expect([...of('more').after].sort()).toEqual([id('contract'), id('impl')].sort());
    expect(made.every((m) => m.splitId === 'split-1' && m.branch.startsWith('agentdeck/'))).toBe(
      true,
    );

    expect(unitBaseOf(of('contract'), made, REPOS)).toEqual({
      kind: 'base',
      repoKey: 'svc',
      ref: 'a'.repeat(40),
      sha: 'a'.repeat(40),
    });
    // Контракт в другом репозитории — порядок, но не основа: страница растёт от базы `app`.
    expect(unitBaseOf(of('page'), made, REPOS)).toMatchObject({ kind: 'base', repoKey: 'app' });
    // Два предшественника в своём репозитории — от последнего созданного (он несёт правки первого).
    expect(unitBaseOf(of('more'), made, REPOS)).toEqual({
      kind: 'predecessor',
      unitId: id('impl'),
      branch: of('impl').branch,
    });
    expect(unitBaseOf({ repoKey: 'gone', after: [] }, made, REPOS)).toEqual({
      unknown: 'repo gone is not a repo of this task',
    });
  });
});

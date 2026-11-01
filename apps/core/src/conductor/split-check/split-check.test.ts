import { describe, expect, it } from 'vitest';
import { decideSplit } from './split-check.ts';
import type { SplitCheckInput, SplitUnit } from './split-check.types.ts';

/**
 * P39 — таблица проверки деления: общий файл, цикл, ёмкость, перекос, ревью одного MR, одна
 * единица по умолчанию. Каждая строка — вход и ожидаемый вердикт с кодами; отказ называет все
 * проблемы сразу.
 */

const unit = (name: string, over: Partial<SplitUnit> = {}): SplitUnit => ({
  name,
  repoKey: 'r1',
  ownedPaths: [`${name}/**`],
  deps: [],
  contract: false,
  estimate: { minutes: null, tokens: null },
  ...over,
});

const input = (units: SplitUnit[], over: Partial<SplitCheckInput> = {}): SplitCheckInput => ({
  units,
  deliverable: { kind: 'change' },
  capacity: { slots: 4, minutes: null },
  foldCase: false,
  ...over,
});

const codes = (i: SplitCheckInput): string[] => {
  const d = decideSplit(i);
  return d.verdict === 'refused' ? d.problems.map((p) => p.code).sort() : [];
};

describe('split check', () => {
  it('P39 table: shared file, dep cycle, unknown dep, one-MR review, solo default', () => {
    const rows: { name: string; in: SplitCheckInput; verdict: string; codes: string[] }[] = [
      { name: 'solo', in: input([unit('a')]), verdict: 'accepted', codes: [] },
      {
        name: 'solo review of one MR',
        in: input([unit('a')], { deliverable: { kind: 'review', mrCount: 1 } }),
        verdict: 'accepted',
        codes: [],
      },
      { name: 'disjoint', in: input([unit('a'), unit('b')]), verdict: 'accepted', codes: [] },
      {
        name: 'shared literal file',
        in: input([unit('a', { ownedPaths: ['src/x.ts'] }), unit('b', { ownedPaths: ['src'] })]),
        verdict: 'refused',
        codes: ['shared-path'],
      },
      {
        name: 'glob covers a literal file',
        in: input([
          unit('a', { ownedPaths: ['src/**/*.ts'] }),
          unit('b', { ownedPaths: ['src/a/b.ts'] }),
        ]),
        verdict: 'refused',
        codes: ['shared-path'],
      },
      {
        name: 'shared but ordered by deps',
        in: input([
          unit('a', { ownedPaths: ['src'] }),
          unit('b', { ownedPaths: ['src'], deps: ['a'] }),
        ]),
        verdict: 'accepted',
        codes: [],
      },
      {
        name: 'same path in different repos is not shared',
        in: input([
          unit('a', { ownedPaths: ['src'] }),
          unit('b', { ownedPaths: ['src'], repoKey: 'r2' }),
        ]),
        verdict: 'accepted',
        codes: [],
      },
      {
        name: 'two globs, known files disjoint',
        in: input(
          [unit('a', { ownedPaths: ['src/*.ts'] }), unit('b', { ownedPaths: ['src/*.css'] })],
          { knownFiles: { r1: ['src/a.ts', 'src/b.css'] } },
        ),
        verdict: 'accepted',
        codes: [],
      },
      {
        name: 'two globs, a known file under both',
        in: input(
          [unit('a', { ownedPaths: ['src/**'] }), unit('b', { ownedPaths: ['src/*.css'] })],
          { knownFiles: { r1: ['src/a.ts', 'src/b.css'] } },
        ),
        verdict: 'refused',
        codes: ['shared-path'],
      },
      {
        name: 'two globs in one dir, files unknown → shared with margin',
        in: input([
          unit('a', { ownedPaths: ['src/*.ts'] }),
          unit('b', { ownedPaths: ['src/*.css'] }),
        ]),
        verdict: 'refused',
        codes: ['shared-path'],
      },
      {
        name: 'dep cycle',
        in: input([unit('a', { deps: ['b'] }), unit('b', { deps: ['a'] })]),
        verdict: 'refused',
        codes: ['cycle'],
      },
      {
        name: 'unknown and self dep named together',
        in: input([unit('a', { deps: ['zz'] }), unit('b', { deps: ['b'] })]),
        verdict: 'refused',
        codes: ['self-dep', 'unknown-dep'],
      },
      {
        name: 'duplicate names',
        in: input([unit('a'), unit('a', { ownedPaths: ['other'] })]),
        verdict: 'refused',
        codes: ['duplicate-name'],
      },
      {
        name: 'one-MR review refused',
        in: input([unit('a'), unit('b')], { deliverable: { kind: 'review', mrCount: 1 } }),
        verdict: 'refused',
        codes: ['one-review'],
      },
      {
        name: 'review without a count refused',
        in: input([unit('a'), unit('b')], { deliverable: { kind: 'review', mrCount: null } }),
        verdict: 'refused',
        codes: ['review-count-unknown'],
      },
      {
        name: 'review of two MRs split',
        in: input([unit('a'), unit('b')], { deliverable: { kind: 'review', mrCount: 2 } }),
        verdict: 'accepted',
        codes: [],
      },
      {
        name: 'all problems at once',
        in: input([unit('a', { deps: ['q'] }), unit('a', { ownedPaths: ['b'] })], {
          deliverable: { kind: 'review', mrCount: 1 },
        }),
        verdict: 'refused',
        codes: ['duplicate-name', 'one-review', 'unknown-dep'],
      },
      { name: 'empty', in: input([]), verdict: 'refused', codes: ['no-units'] },
      {
        name: 'unit in a repo the task does not have',
        in: input([unit('a'), unit('b', { repoKey: 'elsewhere' })], { repoKeys: ['r1'] }),
        verdict: 'refused',
        codes: ['unknown-repo'],
      },
    ];
    for (const row of rows) {
      const d = decideSplit(row.in);
      expect({ row: row.name, verdict: d.verdict, codes: codes(row.in) }).toEqual({
        row: row.name,
        verdict: row.verdict,
        codes: row.codes,
      });
    }
  });

  it('P39 capacity queues past slots and window, imbalance suggests a resplit, never refuses', () => {
    const est = (minutes: number) => ({ estimate: { minutes, tokens: null } });
    const d = decideSplit(
      input([unit('a', est(10)), unit('b', est(10)), unit('c', est(10)), unit('d', est(100))], {
        capacity: { slots: 2, minutes: 50 },
      }),
    );
    expect(d.verdict).toBe('accepted');
    if (d.verdict !== 'accepted') return;
    expect(d.queued).toEqual([
      { unit: 'c', why: 'slots' },
      { unit: 'd', why: 'slots' },
    ]);
    expect(d.suggestions.map((s) => s.unit)).toEqual(['d']);
    // Окно: накопленные 10+10+10 вмещаются в 25? Нет — третья уже за окном.
    const w = decideSplit(
      input([unit('a', est(10)), unit('b', est(10)), unit('c', est(10))], {
        capacity: { slots: 9, minutes: 25 },
      }),
    );
    expect(w.verdict === 'accepted' && w.queued).toEqual([{ unit: 'c', why: 'window' }]);
    expect(w.verdict === 'accepted' && w.suggestions).toEqual([]);
  });

  it('P76 order: contract unit precedes every unit of other repos, deps give the rest', () => {
    const d = decideSplit(
      input([
        unit('web', { repoKey: 'front' }),
        unit('api', { repoKey: 'back', contract: true }),
        unit('docs', { repoKey: 'front', ownedPaths: ['docs'], deps: ['web'] }),
      ]),
    );
    expect(d.verdict).toBe('accepted');
    if (d.verdict !== 'accepted') return;
    expect(d.order).toEqual(['api', 'web', 'docs']);
    expect(d.edges).toEqual(
      expect.arrayContaining([
        { from: 'api', to: 'web', why: 'contract' },
        { from: 'api', to: 'docs', why: 'contract' },
        { from: 'web', to: 'docs', why: 'dep' },
      ]),
    );
    // Два контракта в разных репозиториях ждут друг друга — цикл, названный, не тихий порядок.
    expect(
      codes(
        input([
          unit('a', { repoKey: 'x', contract: true }),
          unit('b', { repoKey: 'y', contract: true }),
        ]),
      ),
    ).toEqual(['cycle']);
  });
});

import { describe, expect, it } from 'vitest';
import type { CorpusCase } from './case-repo.ts';
import { failingCases, judge } from './judge.ts';
import { advisoryItems } from './runners.ts';

const cases: CorpusCase[] = [
  { id: 'key', title: { ru: 'key', en: 'key' }, branch: {}, expect: { secrets: ['a.ts'] } },
  {
    id: 'placeholder',
    title: { ru: 'placeholder', en: 'placeholder' },
    branch: {},
    expect: { secrets: [] },
  },
  {
    id: 'only',
    title: { ru: 'only', en: 'only' },
    branch: {},
    expect: { 'debug-leftovers': ['a.test.ts'] },
  },
];

describe('judge', () => {
  it('сторона права, только когда отметила ровно ожидаемое', () => {
    const rows = judge(
      cases,
      {
        results: {
          key: { secrets: ['a.ts'] },
          placeholder: { secrets: ['README.md'] },
          only: { 'debug-leftovers': ['a.test.ts'] },
        },
        errors: {},
      },
      { results: { key: { secrets: ['a.ts'] }, placeholder: {}, only: {} }, errors: {} },
    );
    const secrets = rows.find((row) => row.sieve === 'secrets')!;
    expect(secrets).toMatchObject({ both: 1, panelOnly: 0, globalOnly: 1, verdict: 'global' });
    expect(secrets.cases.find((item) => item.caseId === 'placeholder')).toMatchObject({
      outcome: 'global',
      panel: { missed: [], extra: ['README.md'] },
    });
    const debug = rows.find((row) => row.sieve === 'debug-leftovers')!;
    expect(debug).toMatchObject({ panelOnly: 1, verdict: 'panel' });
    expect(debug.cases[0]!.global).toEqual({ missed: ['a.test.ts'], extra: [] });
    expect(failingCases(rows, 'panel')).toBe(1);
    expect(failingCases(rows, 'global')).toBe(1);
  });

  it('случай судится только по ситам своего expect — шум чужой ситы не в счёт', () => {
    const rows = judge(
      [cases[0]!],
      { results: { key: { secrets: ['a.ts'], 'tests-alongside': ['a.ts'] } }, errors: {} },
      { results: { key: { secrets: ['a.ts'] } }, errors: {} },
    );
    expect(rows.map((row) => row.sieve)).toEqual(['secrets']);
    expect(rows[0]).toMatchObject({ both: 1, verdict: 'equal' });
  });

  it('сбой прогона стороны — она неправа по всем ситам случая', () => {
    const rows = judge(
      cases,
      { results: {}, errors: { '*': 'missing hooks/lib/x.mjs' } },
      {
        results: {
          key: { secrets: ['a.ts'] },
          placeholder: {},
          only: { 'debug-leftovers': ['a.test.ts'] },
        },
        errors: {},
      },
    );
    expect(rows.every((row) => row.verdict === 'global')).toBe(true);
    expect(failingCases(rows, 'panel')).toBe(3);
    expect(rows[0]!.cases[0]!.panel?.missed[0]).toContain('missing hooks/lib/x.mjs');
  });
});

describe('advisoryItems', () => {
  it('перечень файлов из подсказок хука', () => {
    expect(
      advisoryItems(
        'tests-alongside: product code changed with no test file changed (src/a.ts, src/b.ts) — a behaviour change ships with a test',
      ),
    ).toEqual({ sieve: 'tests-alongside', items: ['src/a.ts', 'src/b.ts'] });
    expect(
      advisoryItems(
        'migration-safety: destructive statements in db/1.sql, db/2.sql — expand → migrate → contract',
      ),
    ).toEqual({ sieve: 'migration-safety', items: ['db/1.sql', 'db/2.sql'] });
    expect(advisoryItems('rollback-plan: high-risk change (data/migration)')).toBeUndefined();
  });
});

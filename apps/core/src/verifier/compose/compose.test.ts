import type {
  CheckRecord,
  CompositionInput,
  CompositionKey,
} from '@agentdeck/contracts/core/records';
import { describe, expect, it } from 'vitest';
import { fixtureEntry, fixtureRegistry } from '../__fixtures__/registry.ts';
import { fixtureRecord, red } from '../red/__fixtures__/record.ts';
import { compose } from './compose.ts';
import { isCoverageSource } from './coverage.ts';

/**
 * Итог (D§3.6, 04:56-59, 04:82-86, P03 отказы итога): обязательный набор по замыканиям, зелёное
 * переиспользуется, второй итог на том же дереве — ноль прогонов, красный того же ключа остаётся
 * красным, сомнение → прогон, отказ называет всё сразу.
 */

const key = (checkId: string, unit: string): string =>
  `${checkId}-${unit}`.padEnd(64, '0').slice(0, 64);
const pair = (checkId: string, unit: string, base = false): CompositionKey => ({
  checkId,
  unit,
  key: { value: key(checkId, unit) },
  baseKey: base ? { value: key(`${checkId}-base`, unit) } : null,
});

// Реестр образца A: app потребляет shared; tests — по пакетам, lint — тоже, без фильтра.
const registry = fixtureRegistry();
const allKeys = [
  ...['app', 'admin', 'shared'].flatMap((u) => [pair('tests', u, true), pair('lint', u)]),
];

function input(over: Partial<CompositionInput> = {}): CompositionInput {
  return {
    repo: 'repo',
    tree: 't'.repeat(64),
    base: 'base',
    registry,
    changed: ['packages/shared/index.ts'],
    records: {},
    quarantine: [],
    coverage: 'warn',
    compositionId: '0192f000-0000-7000-8000-0000000000c0',
    keys: allKeys,
    covered: { value: ['packages/shared/index.ts'] },
    scenarioRequired: [],
    since: 10_000,
    ...over,
  };
}

const pass = (checkId: string, unit: string, over: Partial<CheckRecord> = {}): CheckRecord =>
  fixtureRecord({ key: key(checkId, unit), checkId, unit, ...over });
const recordsOf = (...recs: CheckRecord[]): Record<string, CheckRecord[]> => {
  const out: Record<string, CheckRecord[]> = {};
  for (const r of recs) (out[r.key] ??= []).push(r);
  return out;
};
const greens = () => [
  pass('tests', 'app'),
  pass('tests', 'shared'),
  pass('lint', 'app'),
  pass('lint', 'shared'),
];

describe('verifier/compose compose (D§3.6)', () => {
  it('required set = publish checks × units whose closure the change touches (consumer included); missing records → run', () => {
    const out = compose(input());
    expect(out).toEqual({
      kind: 'run',
      units: [
        { checkId: 'tests', unit: 'app', grade: 'unit' },
        { checkId: 'tests', unit: 'shared', grade: 'unit' },
        { checkId: 'lint', unit: 'app', grade: 'unit' },
        { checkId: 'lint', unit: 'shared', grade: 'unit' },
      ],
    });
    // обвязка задета — все единицы; проверка не publish/deliver — вне набора; единица репозитория — всегда
    const wide = compose(input({ changed: ['vitest.config.ts'] }));
    expect(wide.kind === 'run' && wide.units).toHaveLength(6);
    const projectOnly = compose(
      input({
        registry: fixtureRegistry({
          checks: [
            fixtureEntry({ id: 'e2e', unit: 'project' }),
            fixtureEntry({ id: 'stop-only', requiredAt: ['stop'] }),
          ],
        }),
        changed: ['README.md'],
        keys: [pair('e2e', '.')],
      }),
    );
    expect(projectOnly).toEqual({
      kind: 'run',
      units: [{ checkId: 'e2e', unit: '.', grade: 'unit' }],
    });
  });

  it('all green → ready, records reused; a second compose on the same tree runs nothing (04:57)', () => {
    const records = recordsOf(...greens());
    const out = compose(input({ records }));
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') return;
    expect(out.compositionId).toBe('0192f000-0000-7000-8000-0000000000c0');
    expect(out.units.map((u) => [u.checkId, u.unit, u.verdict, u.reused])).toEqual([
      ['tests', 'app', 'pass', true],
      ['tests', 'shared', 'pass', true],
      ['lint', 'app', 'pass', true],
      ['lint', 'shared', 'pass', true],
    ]);
    const fresh = compose(input({ records, since: 0 }));
    expect(fresh.kind === 'ready' && fresh.units.every((u) => !u.reused)).toBe(true);
    expect(compose(input({ records }))).toEqual(out);
  });

  it.each([
    ['session origin', { origin: 'session' as const }],
    ['unattended (spooled) origin', { origin: 'unattended' as const }],
    ['env not core-prepared', { envPrepared: false }],
    ['narrow grade', { grade: 'narrow' as const }],
    [
      'no-verdict(aborted)',
      { verdict: { kind: 'no-verdict' as const, reason: 'aborted' as const } },
    ],
  ])('a record that does not compose (%s) → the unit runs again', (_name, over) => {
    const recs = greens();
    recs[0] = pass('tests', 'app', over);
    const out = compose(input({ records: recordsOf(...recs) }));
    expect(out).toEqual({ kind: 'run', units: [{ checkId: 'tests', unit: 'app', grade: 'unit' }] });
  });

  it('unknown key → run (doubt → run, 04:55)', () => {
    const keys = allKeys.map((k) =>
      k.checkId === 'tests' && k.unit === 'app' ? { ...k, key: { unknown: 'git timeout' } } : k,
    );
    expect(compose(input({ records: recordsOf(...greens()), keys }))).toEqual({
      kind: 'run',
      units: [{ checkId: 'tests', unit: 'app', grade: 'unit' }],
    });
  });

  it('red on the same key stays red (no rerun) and refuses with a fix step; every unmet condition is named at once (P03)', () => {
    const recs = greens();
    recs[1] = red([{ file: 'packages/shared/s.test.ts', name: 's > breaks' }], {
      key: key('tests', 'shared'),
      unit: 'shared',
    });
    recs[2] = pass('lint', 'app', { verdict: { kind: 'no-verdict', reason: 'env' } });
    const out = compose(
      input({
        records: recordsOf(...recs),
        coverage: 'require',
        changed: [
          'packages/shared/index.ts',
          'packages/shared/new.ts',
          'packages/shared/s.test.ts',
        ],
      }),
    );
    expect(out.kind).toBe('refuse');
    if (out.kind !== 'refuse') return;
    expect(out.unmet.map((u) => [u.code, u.subject.split(' ')[0]])).toEqual([
      ['red-unchanged', 'tests:shared'],
      ['service-env', 'lint:app'],
      ['coverage-gap', 'packages/shared/new.ts'],
    ]);
    expect(out.next).toMatch(/шаг исправления/);
    expect(out.next).toMatch(/окружение/);
  });

  it('a narrow run that selected no test refuses with selection-empty (fix the binding), never as an environment fault', () => {
    const recs = greens();
    recs[2] = pass('lint', 'app', { verdict: { kind: 'no-verdict', reason: 'selection' } });
    const out = compose(input({ records: recordsOf(...recs) }));
    expect(out.kind).toBe('refuse');
    if (out.kind !== 'refuse') return;
    expect(out.unmet.map((u) => [u.code, u.subject.split(' ')[0]])).toEqual([
      ['selection-empty', 'lint:app'],
    ]);
    expect(out.next).toMatch(/имя теста в привязке/);
    expect(out.next).not.toMatch(/почините сервис/);
  });

  it('a red outside the change with no base record asks for a base run; base red too → stale, ready, listed', () => {
    const legacy = { file: 'apps/app/old.test.ts', name: 'old > legacy' };
    const recs = greens();
    recs[0] = red([legacy], { key: key('tests', 'app') });
    const first = compose(input({ records: recordsOf(...recs) }));
    expect(first).toEqual({
      kind: 'run',
      units: [{ checkId: 'tests', unit: 'app', grade: 'base' }],
    });
    const base = red([legacy], { key: key('tests-base', 'app'), grade: 'base' });
    const out = compose(input({ records: recordsOf(...recs, base) }));
    expect(out).toMatchObject({ kind: 'ready', stale: ['tests:app'], flaky: [] });
    // база без подготовленного окружения в итог не входит — снова прогон базы
    const sessionBase = red([legacy], {
      key: key('tests-base', 'app'),
      grade: 'base',
      origin: 'session',
    });
    expect(compose(input({ records: recordsOf(...recs, sessionBase) })).kind).toBe('run');
  });

  it('pass-flaky composes, listed as flaky; quarantine green 3× → listed for un-quarantine; coverage warn lists gaps', () => {
    const recs = greens();
    recs[0] = pass('tests', 'app', { verdict: { kind: 'pass-flaky', retries: ['r.1'] } });
    const out = compose(
      input({
        records: recordsOf(...recs),
        changed: [
          'packages/shared/index.ts',
          'packages/shared/gap.ts',
          'packages/shared/x.test.ts',
        ],
        quarantine: [
          { test: 'q > three', checkId: 'tests', since: 'r.0', greensInRow: 3 },
          { test: 'q > two', checkId: 'tests', since: 'r.0', greensInRow: 2 },
        ],
      }),
    );
    expect(out).toMatchObject({
      kind: 'ready',
      flaky: ['tests:app'],
      coverageGaps: ['packages/shared/gap.ts'],
      unquarantine: ['q > three'],
    });
    // покрытие неизвестно — каждый изменённый исходник назван пробелом, не «покрыт»
    const unknown = compose(
      input({ records: recordsOf(...greens()), covered: { unknown: 'tests unread' } }),
    );
    expect(unknown).toMatchObject({ kind: 'ready', coverageGaps: ['packages/shared/index.ts'] });
  });

  it('a plain green after a red on the same key is flaky-unresolved (one judge with decide): retryable → retry run, otherwise the red stands — never ready/pass', () => {
    const recs = greens();
    const redApp = red([{ file: 'apps/app/a.test.ts', name: 'a > works' }], {
      key: key('tests', 'app'),
      startedAt: 1,
    });
    const greenApp = pass('tests', 'app', { startedAt: 2 });
    recs[0] = greenApp;
    const out = compose(input({ records: recordsOf(...recs, redApp) }));
    expect(out).toEqual({
      kind: 'run',
      units: [{ checkId: 'tests', unit: 'app', grade: 'retry' }],
    });
    // lint без фильтра не повторяется: красный остаётся красным, отказ с шагом исправления
    const redLint = red([], { key: key('lint', 'app'), checkId: 'lint', startedAt: 1 });
    const lint = greens();
    lint[2] = pass('lint', 'app', { startedAt: 2 });
    const refused = compose(input({ records: recordsOf(...lint, redLint) }));
    expect(refused.kind).toBe('refuse');
    if (refused.kind !== 'refuse') return;
    expect(refused.unmet.map((u) => [u.code, u.subject.split(' ')[0]])).toEqual([
      ['red-unchanged', 'lint:app'],
    ]);
    // доказанный переход после красного — зелёный
    const proven = pass('tests', 'app', {
      startedAt: 3,
      verdict: { kind: 'pass-flaky', retries: ['r.1'] },
    });
    const flipped = greens();
    flipped[0] = proven;
    expect(compose(input({ records: recordsOf(...flipped, redApp) }))).toMatchObject({
      kind: 'ready',
      flaky: ['tests:app'],
    });
  });

  it('a code change that no required pair covers refuses (never ready with zero units); a docs-only change composes nothing', () => {
    const outside = compose(
      input({ records: recordsOf(...greens()), changed: ['scripts/deploy.ts'] }),
    );
    expect(outside.kind).toBe('refuse');
    if (outside.kind !== 'refuse') return;
    // Реестр прочитан — отказ «код вне единиц», а не «реестр не читается».
    expect(outside.unmet.map((u) => [u.code, u.subject])).toEqual([
      ['unit-unknown', 'scripts/deploy.ts'],
    ]);
    const noChecks = compose(
      input({ registry: fixtureRegistry({ checks: [] }), changed: ['apps/app/main.ts'] }),
    );
    expect(noChecks).toMatchObject({ kind: 'refuse', unmet: [{ subject: 'apps/app/main.ts' }] });
    expect(compose(input({ changed: ['README.md'] }))).toMatchObject({ kind: 'ready', units: [] });
  });

  it('quarantine matches by (file, test): an entry for the same path in another file does not quarantine the changed red test', () => {
    const t = { file: 'packages/shared/s.test.ts', name: 's > breaks' };
    const recs = greens();
    recs[1] = red([t], { key: key('tests', 'shared'), unit: 'shared' });
    const base = red([t], { key: key('tests-base', 'shared'), unit: 'shared', grade: 'base' });
    const changed = ['packages/shared/index.ts', t.file];
    const elsewhere = compose(
      input({
        records: recordsOf(...recs, base),
        changed,
        quarantine: [
          {
            test: t.name,
            file: 'apps/admin/s.test.ts',
            checkId: 'tests',
            since: 'r',
            greensInRow: 0,
          },
        ],
      }),
    );
    expect(elsewhere).toMatchObject({ kind: 'refuse', unmet: [{ code: 'red-unchanged' }] });
    const own = compose(
      input({
        records: recordsOf(...recs, base),
        changed,
        quarantine: [{ test: t.name, file: t.file, checkId: 'tests', since: 'r', greensInRow: 0 }],
      }),
    );
    expect(own).toMatchObject({ kind: 'ready', flaky: ['tests:shared'] });
  });

  it('coverage source: code, not tests or docs', () => {
    expect(['a/b.ts', 'x.py', 'm.go', 'w.vue'].every(isCoverageSource)).toBe(true);
    expect(
      ['a/b.test.ts', 'a/__tests__/b.ts', 'x_test.go', 'tests/t.py', 'README.md', 'c.json'].some(
        isCoverageSource,
      ),
    ).toBe(false);
  });
});

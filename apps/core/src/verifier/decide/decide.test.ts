import { describe, expect, it } from 'vitest';
import type {
  CheckDecisionInput,
  CheckEntryRoad,
  CheckRecord,
  Unmet,
} from '@agentdeck/contracts/core/records';
import { fixtureEntry, fixtureRegistry } from '../__fixtures__/registry.ts';
import { absentKeyOf } from '../key/index.ts';
import { decideCheck, keyVerdict, WAIT_FLOOR_MS } from './index.ts';

/**
 * Судья класса `check` (00:94, 04 §Decision rules, D§3.5): таблица входов → решение. Каждая ветка
 * вердикта здесь имеет строку, которую ломает её мутант (план mustfail зоны A).
 */

const KEY = 'a'.repeat(64);
const RUN = '0190a000-0000-7000-8000-000000000001';

let seq = 0;
function rec(over: Partial<CheckRecord> = {}): CheckRecord {
  seq += 1;
  return {
    v: 3,
    id: `${KEY}.${seq}`,
    key: KEY,
    parts: {} as CheckRecord['parts'],
    checkId: 'tests',
    unit: 'app',
    grade: 'unit',
    origin: 'core',
    verdict: { kind: 'pass' },
    exit: 0,
    ms: 1000,
    startedAt: seq * 1000,
    argv: ['vitest', 'run', 'apps/app'],
    failing: [],
    retries: [],
    artifacts: [],
    envPrepared: true,
    standEpoch: null,
    taskId: null,
    checkRunId: RUN,
    log: { bytes: 0, truncated: false, sha: 'b'.repeat(64) },
    sig: 'c'.repeat(64),
    ...over,
  };
}

const red = (over: Partial<CheckRecord> = {}) =>
  rec({
    verdict: { kind: 'fail', reason: 'red' },
    exit: 1,
    failing: [{ file: 'apps/app/a.test.ts', name: 'a > breaks' }],
    ...over,
  });

function input(over: Partial<CheckDecisionInput> = {}): CheckDecisionInput {
  return {
    road: 'model-tool',
    entry: fixtureEntry(),
    unit: 'app',
    selection: [],
    blockers: [],
    key: { value: KEY },
    records: { value: [] },
    inflight: null,
    phase: 'final',
    changedUnits: ['app'],
    window: { verdict: 'open', basis: 'economy-window' },
    fresh: null,
    quarantined: [],
    ...over,
  };
}

const withRecords = (records: CheckRecord[], over: Partial<CheckDecisionInput> = {}) =>
  decideCheck(input({ records: { value: records }, ...over }));

const unmet = (code: Unmet['code'], subject: string): Unmet =>
  ({ code, subject, next: `fix ${subject}` }) as Unmet;

describe('verifier/decide', () => {
  it('replays a green record of the same key, header names the record, its time and argv', () => {
    const green = rec();
    const d = withRecords([green, rec({ key: 'f'.repeat(64) })]);
    expect(d).toMatchObject({ kind: 'replay', recordId: green.id });
    expect('header' in d && d.header).toContain(`record ${green.id} (pass)`);
    expect('header' in d && d.header).toContain('argv: vitest run apps/app');
  });

  it('G2 a no-verdict record never replays: aborted/stand/engine/env/selection → run', () => {
    for (const reason of ['aborted', 'engine', 'stand', 'env', 'selection'] as const) {
      const d = withRecords([rec({ verdict: { kind: 'no-verdict', reason }, exit: null })]);
      expect({ reason, kind: d.kind }).toEqual({ reason, kind: 'run' });
    }
  });

  it('D§3.4 a record without restorable artifacts never replays', () => {
    expect(withRecords([rec({ artifacts: null })]).kind).toBe('run');
  });

  it('G13 origin: core replays on any road, session/pseudo only on capture roads, unattended never', () => {
    const roads: CheckEntryRoad[] = [
      'capture-preload',
      'capture-wrapper',
      'pseudo',
      'model-tool',
      'conductor',
      'idle-prerun',
    ];
    const table = (origin: CheckRecord['origin']) =>
      roads.map((road) => withRecords([rec({ origin })], { road }).kind);
    expect(table('core')).toEqual(Array(6).fill('replay'));
    expect(table('session')).toEqual(['replay', 'replay', 'replay', 'run', 'run', 'run']);
    expect(table('pseudo')).toEqual(['replay', 'replay', 'replay', 'run', 'run', 'run']);
    expect(table('unattended')).toEqual(Array(6).fill('run'));
  });

  it('a newer red that cannot be the answer still hides the older green: no artifacts, session off a capture road, unattended → run', () => {
    const cases: [Partial<CheckRecord>, CheckEntryRoad][] = [
      [{ artifacts: null }, 'model-tool'],
      [{ origin: 'session' }, 'model-tool'],
      [{ origin: 'unattended' }, 'conductor'],
    ];
    for (const [over, road] of cases) {
      const green = rec();
      const d = withRecords([green, red(over)], { road });
      expect({ over, kind: d.kind }).toEqual({ over, kind: 'run' });
    }
    // ключ зелёный по всем записям: отвечает последний повторимый зелёный, а не прогон
    const replayableGreen = rec();
    expect(withRecords([replayableGreen, rec({ artifacts: null })])).toMatchObject({
      kind: 'replay',
      recordId: replayableGreen.id,
    });
  });

  it('a red record of the same key replays with a change-first header naming the failing tests and quarantine', () => {
    const r = red();
    const d = withRecords([r], { quarantined: ['a > breaks'] });
    expect(d).toMatchObject({ kind: 'replay', recordId: r.id });
    expect('header' in d && d.header).toContain('change the failing code first: a > breaks');
    expect('header' in d && d.header).toContain('(quarantined: a > breaks)');
  });

  it('M5 green-flaky only with measured retries: red then pass-flaky{retries} is green, pass-flaky{[]} is not', () => {
    const r = red();
    const flaky = rec({ verdict: { kind: 'pass-flaky', retries: [r.id] } });
    expect(withRecords([r, flaky])).toMatchObject({ kind: 'replay', recordId: flaky.id });
    const r2 = red();
    const fake = rec({ verdict: { kind: 'pass-flaky', retries: [] } });
    expect(withRecords([r2, fake])).toMatchObject({ kind: 'replay', recordId: r2.id });
    expect(keyVerdict([r2, fake]).kind).toBe('red');
  });

  it('a red beside a plain green on the same key is flaky-unresolved: test runner retries the failing tests, base-dependent replays the red', () => {
    const g = rec();
    const r = red();
    expect(withRecords([g, r])).toEqual({
      kind: 'run',
      grade: 'retry',
      selection: ['a > breaks'],
      reason: expect.stringContaining(`flaky-unresolved at ${r.id}`),
    });
    expect(withRecords([r, rec()]).kind).toBe('run');
    expect(withRecords([g, r], { entry: fixtureEntry({ baseDependent: true }) })).toMatchObject({
      kind: 'replay',
      recordId: r.id,
    });
    expect(withRecords([g, r], { entry: fixtureEntry({ class: 'static' }) })).toMatchObject({
      kind: 'replay',
      recordId: r.id,
    });
  });

  it('G3 an absent entry answers with the fail{absent} record of its key, else asks for it to be written — never green', () => {
    const { key } = absentKeyOf('nope', fixtureRegistry());
    const absentRec = rec({ key, verdict: { kind: 'fail', reason: 'absent' }, unit: '' });
    const base = { entry: null, unit: '', key: { value: key } };
    expect(withRecords([absentRec], base)).toEqual({ kind: 'absent', recordId: absentRec.id });
    // Зелёная запись того же ключа ответом на «нет в реестре» не бывает.
    const d = withRecords([rec({ key })], base);
    expect(d).toMatchObject({ kind: 'run', grade: 'unit', selection: [] });
    expect('reason' in d && d.reason).toMatch(/^absent-unrecorded/);
    // Ключ не вычислен (дерево git не прочиталось) — прогон; нечитаемый реестр сюда не доходит:
    // вход проверки отказывает раньше (`registry-unreadable`, fix-w2R-X01).
    expect(decideCheck(input({ ...base, key: { unknown: 'git tree unreadable' } })).kind).toBe(
      'run',
    );
  });

  it('single-flight: a running neighbour of the same key → wait until max(2× median, 10 min)', () => {
    const inflight = { checkRunId: RUN, since: 5_000 };
    const ms = [1_000, 400_000, 900_000].map((m) => rec({ ms: m, artifacts: null }));
    expect(withRecords(ms, { inflight })).toEqual({
      kind: 'wait',
      checkRunId: RUN,
      deadlineMs: 5_000 + 800_000,
    });
    expect(withRecords([], { inflight })).toEqual({
      kind: 'wait',
      checkRunId: RUN,
      deadlineMs: 5_000 + WAIT_FLOOR_MS,
    });
    // Повтор записи дешевле ожидания: зелёная запись отвечает и при соседнем прогоне.
    expect(withRecords([rec()], { inflight }).kind).toBe('replay');
  });

  it('G12 only a refused window defers; open and warn never block a run', () => {
    const refused = withRecords([], {
      window: { verdict: 'refused', basis: 'economy-window' },
    });
    expect(refused).toMatchObject({ kind: 'defer', until: 'window' });
    for (const verdict of ['open', 'warn'] as const)
      expect(withRecords([], { window: { verdict, basis: 'economy-window' } }).kind).toBe('run');
    expect(
      withRecords([rec()], { window: { verdict: 'refused', basis: 'economy-window' } }).kind,
    ).toBe('replay');
  });

  it('P03 disk alone defers; any other blocker → ONE refusal naming every unmet condition once', () => {
    expect(withRecords([], { blockers: [unmet('disk', 'C:')] })).toEqual({
      kind: 'defer',
      until: 'disk',
      reason: 'C:',
    });
    const blockers = [
      unmet('disk', 'C:'),
      unmet('service-env', 'postgres'),
      unmet('budget', 'window'),
      unmet('service-env', 'postgres'),
    ];
    expect(withRecords([], { blockers })).toEqual({
      kind: 'refuse',
      unmet: blockers.slice(0, 3),
      next: 'C:: fix C:; postgres: fix postgres; window: fix window',
    });
  });

  it('04:56 phase: mid-task narrows to changed units; a changed unit runs the selection narrow or the whole unit as unit; final the same', () => {
    expect(
      withRecords([], { phase: 'mid-task', unit: 'admin', changedUnits: ['shared', 'app'] }),
    ).toMatchObject({ kind: 'narrow', units: ['app', 'shared'], selection: [] });
    expect(withRecords([], { phase: 'mid-task', selection: ['a.test.ts'] })).toMatchObject({
      kind: 'run',
      grade: 'narrow',
      selection: ['a.test.ts'],
    });
    // A1r4-F02: вся изменённая единица посреди работы — разряд `unit`, его зелёный годится итогу.
    expect(withRecords([], { phase: 'mid-task' })).toMatchObject({
      kind: 'run',
      grade: 'unit',
      selection: [],
    });
    expect(withRecords([])).toMatchObject({ kind: 'run', grade: 'unit', selection: [] });
    expect(withRecords([], { selection: ['x'] })).toMatchObject({ kind: 'run', grade: 'narrow' });
  });

  it('a fresh one-shot that matches (check id, unit, key) skips the replay; a foreign one does not', () => {
    const g = rec();
    for (const fresh of [
      { scope: 'check', ref: 'tests' },
      { scope: 'unit', ref: 'app' },
      { scope: 'key', ref: KEY },
    ] as const)
      expect(withRecords([g], { fresh }).kind).toBe('run');
    for (const fresh of [
      { scope: 'check', ref: 'lint' },
      { scope: 'unit', ref: 'admin' },
      { scope: 'key', ref: 'f'.repeat(64) },
    ] as const)
      expect(withRecords([g], { fresh }).kind).toBe('replay');
  });

  it('04:55 doubt → run: an unknown key or unreadable records never replay and never refuse', () => {
    const g = rec();
    const k = decideCheck(input({ key: { unknown: 'git.tree timeout' }, records: { value: [g] } }));
    expect(k).toMatchObject({ kind: 'run', grade: 'unit' });
    expect('reason' in k && k.reason).toContain('git.tree timeout');
    const r = decideCheck(input({ records: { unknown: 'EPERM' } }));
    expect('reason' in r && r.reason).toContain('records EPERM');
  });

  it('P02/P5 pure: the same input gives the same decision on every call and on every road for core records', () => {
    const records = [red(), rec({ verdict: { kind: 'pass-flaky', retries: ['x.0'] } })];
    const first = withRecords(records);
    for (const road of ['capture-preload', 'conductor', 'idle-prerun'] as const)
      expect(withRecords(records, { road })).toEqual(first);
    expect(withRecords(records)).toEqual(first);
  });
});

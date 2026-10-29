import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { foldsCaseAt } from '../../platform/paths.ts';
import { fixtureEntry, fixtureRegistry } from '../__fixtures__/registry.ts';
import { fixtureRecord, red } from '../red/__fixtures__/record.ts';
import { readLinkedCases } from './cases.ts';
import { caseHits } from './map.ts';
import type { CaseScope, LinkedCase } from './tests-block.types.ts';
import { coreRunId, writeCaseRuns } from './write.ts';

/**
 * Писатель блока тестов (P50, G14, G15): запись проверки, легшая на кейсы, — прогон истории с
 * `origin:'core'` и id записи; проверка без кейса остаётся записью; хранилище не создаётся.
 */

const scope: CaseScope = { entry: fixtureEntry(), units: fixtureRegistry().units };
const A: LinkedCase = {
  groupId: 'g',
  caseId: 'g-001',
  file: 'apps/app/a.test.ts',
  testName: 'a > works',
};
const A_DESCRIBE: LinkedCase = { groupId: 'g', caseId: 'g-002', file: A.file, testName: 'a' };
const A_FILE: LinkedCase = { groupId: 'g', caseId: 'g-003', file: A.file };
const ADMIN: LinkedCase = { groupId: 'g', caseId: 'g-004', file: 'apps/admin/b.test.ts' };
const OTHER_IN_APP: LinkedCase = {
  groupId: 'h',
  caseId: 'h-001',
  file: 'apps/app/c.test.ts',
  testName: 'c > ok',
};
const ALL = [A, A_DESCRIBE, A_FILE, ADMIN, OTHER_IN_APP];
const statuses = (hits: ReturnType<typeof caseHits>) =>
  Object.fromEntries(hits.map((h) => [h.caseId, h.status]));

describe('verifier/tests-block caseHits (P50 mapping by automation.file + full testName)', () => {
  const A_RAN = { file: 'apps/app/a.test.ts', name: 'a > works' };
  const C_RAN = { file: 'apps/app/c.test.ts', name: 'c > ok' };

  it('a green unit record proves every linked case inside its unit whose test it names, none outside', () => {
    expect(statuses(caseHits(fixtureRecord({ passing: [A_RAN, C_RAN] }), scope, ALL))).toEqual({
      'g-001': 'passed',
      'g-002': 'passed',
      'g-003': 'passed',
      'h-001': 'passed',
    });
  });

  it('a renamed or deleted test is not green under a green unit: no passing list proves no named test', () => {
    const renamed = fixtureRecord({ passing: [{ file: A_RAN.file, name: 'a > renamed' }, C_RAN] });
    // describe «a» и весь файл ещё исполнены; тест «a > works» — нет
    expect(statuses(caseHits(renamed, scope, ALL))).toEqual({
      'g-002': 'passed',
      'g-003': 'passed',
      'h-001': 'passed',
    });
    // вывод без имён прошедших (обычный репортёр vitest): ни один тест не доказан, и файл тоже —
    // его могли удалить (records.ts `passing`, P50)
    expect(caseHits(fixtureRecord(), scope, ALL)).toEqual([]);
    const deleted: LinkedCase = { ...A_FILE, file: 'apps/app/deleted-long-ago.test.ts' };
    expect(caseHits(fixtureRecord({ passing: [A_RAN] }), scope, [deleted])).toEqual([]);
    // зелёный узкий прогон ровно этого файла файл доказывает
    const narrowFile = fixtureRecord({
      grade: 'narrow',
      parts: { ...fixtureRecord().parts, selection: [A.file] },
    });
    expect(statuses(caseHits(narrowFile, scope, [A_FILE]))).toEqual({ 'g-003': 'passed' });
    // то же имя теста в чужом файле — не тест кейса
    const sameNameElsewhere = fixtureRecord({ passing: [{ file: C_RAN.file, name: A.testName! }] });
    expect(caseHits(sameNameElsewhere, scope, [A])).toEqual([]);
    // список с файлами, где файла кейса нет, — файл не исполнялся
    const otherFile = fixtureRecord({ passing: [C_RAN] });
    expect(statuses(caseHits(otherFile, scope, [A_FILE, OTHER_IN_APP]))).toEqual({
      'h-001': 'passed',
    });
    // имена без файлов (go, cargo): тест по имени; файл кейса на весь файл не назван — не доказан
    const nameOnly = fixtureRecord({ passing: [{ name: 'a > works' }] });
    expect(statuses(caseHits(nameOnly, scope, [A, A_FILE, OTHER_IN_APP]))).toEqual({
      'g-001': 'passed',
    });
  });

  it('red: the failing test lands on its case, its describe path and its whole-file case; the named rest passed', () => {
    const rec = red([A_RAN], { passing: [C_RAN] });
    const hits = caseHits(rec, scope, ALL);
    expect(statuses(hits)).toEqual({
      'g-001': 'failed',
      'g-002': 'failed',
      'g-003': 'failed',
      'h-001': 'passed',
    });
    expect(hits[0]?.failedTests).toEqual([{ name: 'a > works', owner: 'apps/app/a.test.ts' }]);
    // путь раннера — от его cwd; кейс — от корня проекта
    const inCwd = { ...scope, entry: fixtureEntry({ cwd: 'apps/app' }) };
    const cwdRed = red([{ file: 'a.test.ts', name: 'a > works' }], {
      passing: [{ file: 'c.test.ts', name: 'c > ok' }],
    });
    expect(statuses(caseHits(cwdRed, inCwd, [A, OTHER_IN_APP]))).toEqual({
      'g-001': 'failed',
      'h-001': 'passed',
    });
    // красный без списка прошедших: не упавший тест кейса не назван — вердикта нет
    expect(statuses(caseHits(red([A_RAN]), scope, [A, OTHER_IN_APP]))).toEqual({
      'g-001': 'failed',
    });
  });

  it('red: a whole-file case is passed only when its file is named among the passing and the log is whole', () => {
    // обрезанный лог: падение a.test.ts ушло в вырезанную середину, в голове — один его прошедший
    const cut = red([C_RAN], {
      passing: [A_RAN],
      log: { bytes: 3e6, truncated: true, sha: '0'.repeat(64) },
    });
    expect(caseHits(cut, scope, [A_FILE, A])).toEqual([]);
    // красный без списка прошедших, упал чужой файл: файл кейса не назван — вердикта нет
    expect(caseHits(red([C_RAN]), scope, [A_FILE])).toEqual([]);
    // тот же лог целиком: файл назван прошедшим, падений в нём нет
    expect(statuses(caseHits(red([C_RAN], { passing: [A_RAN] }), scope, [A_FILE]))).toEqual({
      'g-003': 'passed',
    });
  });

  it.skipIf(!foldsCaseAt(undefined))(
    'red: on a case-folding volume a failing path that differs only in letter case is the case’s own file',
    () => {
      const upper = red([{ file: 'apps/app/A.test.ts', name: 'a > works' }], { passing: [C_RAN] });
      expect(statuses(caseHits(upper, scope, [A_FILE]))).toEqual({ 'g-003': 'failed' });
    },
  );

  it('a red with no parsed names, or a nameless-file failure against a whole-file case, gives no verdict', () => {
    expect(caseHits(red([], { passing: [A_RAN, C_RAN] }), scope, ALL)).toEqual([]);
    const noFile = red([{ name: 'x > y' }], { passing: [A_RAN] });
    expect(statuses(caseHits(noFile, scope, [A, A_FILE]))).toEqual({ 'g-001': 'passed' });
  });

  it('pass-flaky → passed with the retry count (the first-run failures count as ran); base, retry, absent, no-verdict and non-runner records write nothing', () => {
    const flaky = fixtureRecord({
      verdict: { kind: 'pass-flaky', retries: ['r.1', 'r.2'] },
      failing: [A_RAN],
      passing: [C_RAN],
    });
    expect(caseHits(flaky, scope, [A])).toEqual([
      { groupId: 'g', caseId: 'g-001', status: 'passed', flakyAttempts: 2 },
    ]);
    // вывод без прошедших: исполненным назван только флак, тест другого кейса — нет
    const bare = fixtureRecord({
      verdict: { kind: 'pass-flaky', retries: ['r.1'] },
      failing: [A_RAN],
    });
    expect(statuses(caseHits(bare, scope, [A, OTHER_IN_APP]))).toEqual({ 'g-001': 'passed' });
    for (const rec of [
      fixtureRecord({ grade: 'base', passing: [A_RAN] }),
      fixtureRecord({ grade: 'retry', passing: [A_RAN] }),
      fixtureRecord({ verdict: { kind: 'fail', reason: 'absent' } }),
      fixtureRecord({ verdict: { kind: 'no-verdict', reason: 'stand' } }),
    ])
      expect(caseHits(rec, scope, ALL)).toEqual([]);
    const lint = { ...scope, entry: fixtureEntry({ id: 'lint', class: 'static' }) };
    expect(caseHits(fixtureRecord({ checkId: 'lint', passing: [A_RAN] }), lint, ALL)).toEqual([]);
  });

  it('a narrow record proves only cases wholly under its selection; an unknown unit proves none', () => {
    const narrow = (selection: string[], passing?: (typeof A_RAN)[]) =>
      fixtureRecord({
        grade: 'narrow',
        parts: { ...fixtureRecord().parts, selection },
        ...(passing ? { passing } : {}),
      });
    expect(statuses(caseHits(narrow(['apps/app/a.test.ts'], [A_RAN]), scope, ALL))).toEqual({
      'g-001': 'passed',
      'g-002': 'passed',
      'g-003': 'passed',
    });
    // прогон одного теста не доказывает describe целиком и весь файл; выборка ровно этого теста —
    // доказательство и без списка прошедших (пустая выборка зелёной не бывает, D§3.7)
    expect(statuses(caseHits(narrow(['a > works']), scope, ALL))).toEqual({ 'g-001': 'passed' });
    expect(caseHits(narrow(['a']), scope, [A])).toEqual([]);
    expect(caseHits(fixtureRecord({ unit: 'ghost', passing: [A_RAN] }), scope, ALL)).toEqual([]);
    const project = { ...scope, entry: fixtureEntry({ unit: 'project' }) };
    const all = fixtureRecord({
      unit: '.',
      passing: [A_RAN, C_RAN, { file: 'apps/admin/b.test.ts', name: 'b > ok' }],
    });
    expect(caseHits(all, project, ALL)).toHaveLength(5);
  });
});

describe('verifier/tests-block writeCaseRuns (G14, G15, throwaway project dir)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const project = (withStore: boolean): string => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-'));
    dirs.push(dir);
    if (!withStore) return dir;
    const store = join(dir, '.agent', 'tests');
    mkdirSync(store, { recursive: true });
    const auto = (file: string, testName?: string) => ({
      status: 'automated',
      file,
      ...(testName ? { testName } : {}),
    });
    writeFileSync(
      join(store, 'g.tests.json'),
      JSON.stringify({
        version: 1,
        title: 'G',
        cases: [
          { id: 'g-001', title: 'a', automation: auto(A.file, A.testName) },
          { id: 'g-002', title: 'manual', automation: { status: 'manual' } },
        ],
      }),
    );
    // часть разбитой группы: кейсы её — группы `big`
    writeFileSync(
      join(store, 'big--part.tests.json'),
      JSON.stringify({
        group: 'big',
        cases: [{ id: 'big-001', automation: auto(OTHER_IN_APP.file) }],
      }),
    );
    return dir;
  };

  it('writes ONE run per record: origin core, coreRecordId, results per mapped case; rewriting is idempotent', () => {
    const dir = project(true);
    const rec = red([{ file: A.file, name: 'a > works' }], {
      exit: 1,
      passing: [{ file: OTHER_IN_APP.file, name: 'c > ok' }],
    });
    const out = writeCaseRuns(rec, dir, scope);
    expect('value' in out && out.value).toHaveLength(1);
    const runs = readdirSync(join(dir, '.agent', 'tests', 'runs'));
    expect(runs).toHaveLength(1);
    const run = JSON.parse(readFileSync(join(dir, '.agent', 'tests', 'runs', runs[0]!), 'utf8'));
    expect(run).toMatchObject({
      id: coreRunId(rec.id),
      mode: 'import',
      origin: 'core',
      coreRecordId: rec.id,
      exitCode: 1,
      summary: { total: 2, passed: 1, failed: 1 },
    });
    expect(
      run.results.map((r: { pointId: string; status: string }) => [r.pointId, r.status]),
    ).toEqual([
      ['big:big-001', 'passed'],
      ['g:g-001', 'failed'],
    ]);
    expect(writeCaseRuns(rec, dir, scope)).toEqual(out);
    expect(readdirSync(join(dir, '.agent', 'tests', 'runs'))).toHaveLength(1);
  });

  it('a check with no case stays a record (no run file); a repo without a store gets nothing created', () => {
    const dir = project(true);
    expect(writeCaseRuns(fixtureRecord({ unit: 'admin' }), dir, scope)).toEqual({ value: [] });
    expect(readdirSync(join(dir, '.agent', 'tests'))).not.toContain('runs');
    const bare = project(false);
    expect(writeCaseRuns(fixtureRecord(), bare, scope)).toEqual({ absent: true });
    expect(readdirSync(bare)).toEqual([]);
  });

  it('an unreadable group file → unknown, nothing written (never a run that skipped a case)', () => {
    const dir = project(true);
    writeFileSync(join(dir, '.agent', 'tests', 'broken.tests.json'), '{');
    expect(readLinkedCases(join(dir, '.agent', 'tests'))).toMatchObject({
      unknown: expect.stringMatching(/broken/),
    });
    expect(writeCaseRuns(fixtureRecord(), dir, scope)).toMatchObject({
      unknown: expect.any(String),
    });
    expect(readdirSync(join(dir, '.agent', 'tests'))).not.toContain('runs');
  });

  it('a run file torn by a crash mid-write is rewritten whole on the replay, never reported as written', () => {
    const dir = project(true);
    const rec = red([{ file: A.file, name: 'a > works' }]);
    const first = writeCaseRuns(rec, dir, scope);
    const path = 'value' in first ? first.value[0]! : '';
    const whole = readFileSync(path, 'utf8');
    writeFileSync(path, '{"id":"');
    expect(writeCaseRuns(rec, dir, scope)).toEqual({ value: [path] });
    expect(readFileSync(path, 'utf8')).toBe(whole);
    expect(readdirSync(join(dir, '.agent', 'tests', 'runs'))).toHaveLength(1);
  });
});

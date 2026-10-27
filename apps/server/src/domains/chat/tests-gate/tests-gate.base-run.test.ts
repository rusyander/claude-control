import { describe, expect, it } from 'vitest';
import type {
  ProjectTestCase,
  ProjectTestGroup,
  ProjectTestPointResult,
  ProjectTestRunRecord,
  ProjectTestStatus,
} from '@agentdeck/contracts';
import { judgeTests } from './tests-gate.ts';

/**
 * Прогон на развилке с основной (#g0:109, 25.10): g0 стояла на inst-api-007/014 —
 * красных от Windows, но без прогона до старта группы, и доказать «не из-за ветки»
 * было нечем. `tests-cli run --base` снимает этот довод сейчас; ворота берут его
 * первым, но снимают кейс только красным с той же подписью: развилка гонится без
 * зависимостей копии, и её «Cannot find module» ничего не доказывает.
 */

const STARTED = '2026-10-25T10:00:00.000Z';
const BEFORE = '2026-10-24T09:00:00.000Z';
const AFTER = '2026-10-25T10:30:00.000Z';
const ON_BASE = '2026-10-25T10:40:00.000Z';
const COMMAND = 'node tests-cli.mjs run --project .';
const WINDOWS_RED = 'TestServeFile: files_test.go:88: unexpected path separator «\\»';

const testCase = (id: string, extra: Partial<ProjectTestCase> = {}): ProjectTestCase =>
  ({
    id,
    type: 'case',
    title: id,
    steps: [],
    status: 'unknown',
    source: 'human',
    automation: { status: 'automated', file: `tests/${id}_test.go` },
    ...extra,
  }) as ProjectTestCase;

const groups = (cases: ProjectTestCase[]): ProjectTestGroup[] => [
  { id: 'inst', title: 'Inst', file: 'inst.tests.json', cases },
];

type Row = [string, ProjectTestStatus, Partial<ProjectTestPointResult>?];

const run = (id: string, startedAt: string, rows: Row[]): ProjectTestRunRecord =>
  ({
    id,
    mode: 'import',
    actor: 'ci',
    status: 'done',
    startedAt,
    finishedAt: startedAt,
    results: rows.map(([caseId, status, extra]) => ({
      pointId: caseId,
      groupId: 'inst',
      caseId,
      status,
      ...extra,
    })),
    summary: { total: rows.length, passed: 0, failed: 0, skipped: 0, blocked: 0 },
  }) as ProjectTestRunRecord;

const users = testCase('inst-users-001', { codePaths: ['src/users'] });
const api = testCase('inst-api-007', { codePaths: ['src/api'] });

const red = (note: string): Row => ['inst-api-007', 'failed', { note }];
const own = run('own', AFTER, [['inst-users-001', 'passed'], red(WINDOWS_RED)]);

const judge = (input: {
  paths: string[];
  runs?: ProjectTestRunRecord[];
  baseRuns?: ProjectTestRunRecord[];
}) =>
  judgeTests({
    groups: groups([users, api]),
    runs: input.runs ?? [own],
    paths: input.paths,
    startedAt: STARTED,
    command: COMMAND,
    ...(input.baseRuns ? { baseRuns: input.baseRuns } : {}),
  });

describe('прогон на развилке с основной — довод «красное не из-за ветки»', () => {
  it('без прогона до старта и без развилки — держит, и пробел называет команду развилки ровно на эти кейсы', () => {
    const verdict = judge({ paths: ['src/users/list.ts'] });
    expect(verdict.missing).toEqual([
      expect.stringContaining('run --project . --case inst:inst-api-007 --base'),
    ]);
  });

  it('незадетый: на развилке тот же красный — заметка «и без ветки», доставку не держит', () => {
    const verdict = judge({
      paths: ['src/users/list.ts'],
      baseRuns: [run('fork', ON_BASE, [red(WINDOWS_RED)])],
    });
    expect(verdict.missing).toEqual([]);
    expect(verdict.noted).toEqual(['inst-api-007']);
    expect(verdict.notes?.[0]).toContain('на развилке с основной');
  });

  it('задетый диффом: на развилке тот же красный — заметка; другой красный — держит', () => {
    const paths = ['src/users/list.ts', 'src/api/files.go'];
    const same = judge({ paths, baseRuns: [run('fork', ON_BASE, [red(WINDOWS_RED)])] });
    expect(same.noted).toEqual(['inst-api-007']);
    const other = judge({
      paths,
      baseRuns: [run('fork', ON_BASE, [red('TestList: list_test.go:12: want 3, got 2')])],
    });
    expect(other.missing).toEqual([expect.stringContaining('inst-api-007')]);
  });

  it('незадетый: на развилке красный с другой подписью (нет зависимостей) — держит, ложного «не из-за ветки» нет', () => {
    const verdict = judge({
      paths: ['src/users/list.ts'],
      baseRuns: [run('fork', ON_BASE, [red("Error: Cannot find module 'vitest'")])],
    });
    expect(verdict.missing).toEqual([expect.stringContaining('inst-api-007')]);
    expect(verdict.noted).toBeUndefined();
  });

  it('на развилке красный другой подписью (не собралось) — не довод: прогон до старта судит, как без развилки', () => {
    // g0 25.10: `go.sum` в .gitignore, дерево развилки без него — «(build): missing go.sum entry».
    const broken = run('fork', ON_BASE, [
      red('(build): # inst-api/internal/pipeline missing go.sum entry'),
    ]);
    const runs = [run('before', BEFORE, [red(WINDOWS_RED)]), own];
    const untouched = judge({ paths: ['src/users/list.ts'], runs, baseRuns: [broken] });
    expect(untouched.missing).toEqual([]);
    expect(untouched.noted).toEqual(['inst-api-007']);
    const touched = judge({
      paths: ['src/users/list.ts', 'src/api/files.go'],
      runs,
      baseRuns: [broken],
    });
    expect(touched.missing).toEqual([]);
    expect(touched.noted).toEqual(['inst-api-007']);
  });

  it('на развилке зелёный — сильнее прогона до старта: красный ветки держит', () => {
    const verdict = judge({
      paths: ['src/users/list.ts'],
      runs: [run('before', BEFORE, [red(WINDOWS_RED)]), own],
      baseRuns: [run('fork', ON_BASE, [['inst-api-007', 'passed']])],
    });
    expect(verdict.missing).toEqual([expect.stringContaining('inst-api-007')]);
  });
});

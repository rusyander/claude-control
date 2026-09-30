import { describe, expect, it } from 'vitest';
import type {
  ProjectTestCase,
  ProjectTestGroup,
  ProjectTestRunRecord,
  ProjectTestStatus,
} from '@agentdeck/contracts';
import { judgeTests } from './tests-gate.ts';

/**
 * Вердикт группы разделения из блока «Тесты» её копии (решение владельца
 * 29.09): кейсы, задетые диффом, и прогоны, записанные после старта группы.
 */

const STARTED = '2026-09-30T10:00:00.000Z';
const COMMAND = 'node tests-cli.mjs run --project .';

const testCase = (id: string, extra: Partial<ProjectTestCase> = {}): ProjectTestCase =>
  ({
    id,
    type: 'case',
    title: id,
    steps: [],
    status: 'unknown',
    source: 'human',
    automation: { status: 'automated', file: `tests/${id}.spec.ts` },
    ...extra,
  }) as ProjectTestCase;

const groups = (cases: ProjectTestCase[]): ProjectTestGroup[] => [
  { id: 'auth', title: 'Auth', file: 'auth.tests.json', cases },
];

const run = (
  id: string,
  startedAt: string,
  results: [string, ProjectTestStatus][],
): ProjectTestRunRecord =>
  ({
    id,
    mode: 'import',
    actor: 'ci',
    status: 'done',
    startedAt,
    finishedAt: startedAt,
    results: results.map(([caseId, status]) => ({
      pointId: caseId,
      groupId: 'auth',
      caseId,
      status,
    })),
    summary: { total: results.length, passed: 0, failed: 0, skipped: 0, blocked: 0 },
  }) as ProjectTestRunRecord;

const login = testCase('auth-001', { codePaths: ['src/auth'] });
const logout = testCase('auth-002', { codePaths: ['src/auth/logout.ts'] });
const billing = testCase('bill-001', { codePaths: ['src/billing'] });

describe('вердикт группы из блока «Тесты»', () => {
  it('кейсов в копии нет — проверять нечем, группу не держит', () => {
    expect(
      judgeTests({ groups: groups([]), runs: [], paths: ['src/a.ts'], command: COMMAND }),
    ).toEqual({ missing: [], unchecked: 'no-cases' });
  });

  it('задетые кейсы, а прогона после старта нет — пробел с командой записи', () => {
    const verdict = judgeTests({
      groups: groups([login, logout, billing]),
      runs: [run('old', '2026-09-30T09:00:00.000Z', [['auth-001', 'passed']])],
      paths: ['src/auth/logout.ts'],
      startedAt: STARTED,
      command: COMMAND,
    });
    expect(verdict.missing).toHaveLength(1);
    expect(verdict.missing[0]).toContain('auth-001, auth-002');
    expect(verdict.missing[0]).toContain(COMMAND);
    expect(verdict.verdict).toEqual({ cases: 2, passed: 0 });
  });

  it('все задетые зелёные в прогоне группы — пробелов нет, вердикт с прогоном', () => {
    const verdict = judgeTests({
      groups: groups([login, logout, billing]),
      runs: [
        run('r1', '2026-09-30T10:30:00.000Z', [
          ['auth-001', 'passed'],
          ['auth-002', 'passed'],
        ]),
      ],
      paths: ['src/auth/logout.ts'],
      startedAt: STARTED,
      command: COMMAND,
    });
    expect(verdict.missing).toEqual([]);
    expect(verdict.verdict).toMatchObject({ cases: 2, passed: 2, runId: 'r1' });
  });

  it('последний результат решает: упал, потом прошёл — зелёный; прошёл, потом упал — красный', () => {
    const verdict = judgeTests({
      groups: groups([login, logout]),
      runs: [
        run('r1', '2026-09-30T10:10:00.000Z', [
          ['auth-001', 'failed'],
          ['auth-002', 'passed'],
        ]),
        run('r2', '2026-09-30T10:20:00.000Z', [
          ['auth-001', 'passed'],
          ['auth-002', 'failed'],
        ]),
      ],
      paths: ['src/auth/login.ts'],
      startedAt: STARTED,
      command: COMMAND,
    });
    expect(verdict.missing).toEqual([expect.stringContaining('auth-002')]);
    expect(verdict.missing[0]).not.toContain('auth-001');
  });

  it('задетый кейс не прогнан в прогоне группы — пробел «не прогнаны»', () => {
    const verdict = judgeTests({
      groups: groups([login, logout]),
      runs: [run('r1', '2026-09-30T10:30:00.000Z', [['auth-001', 'passed']])],
      paths: ['src/auth/logout.ts'],
      startedAt: STARTED,
      command: COMMAND,
    });
    expect(verdict.missing).toEqual([expect.stringContaining('auth-002')]);
    expect(verdict.verdict).toMatchObject({ cases: 2, passed: 1 });
  });

  it('красный кейс в карантине группу не держит', () => {
    const verdict = judgeTests({
      groups: groups([login, testCase('auth-003', { muted: true, codePaths: ['src/x'] })]),
      runs: [
        run('r1', '2026-09-30T10:30:00.000Z', [
          ['auth-001', 'passed'],
          ['auth-003', 'failed'],
        ]),
      ],
      paths: ['src/auth/login.ts'],
      startedAt: STARTED,
      command: COMMAND,
    });
    expect(verdict.missing).toEqual([]);
  });

  it('кейсы привязаны к файлам, а дифф группы не покрыт ни одним — «заведите кейс»', () => {
    const verdict = judgeTests({
      groups: groups([login]),
      runs: [],
      paths: ['src/reports/export.ts'],
      startedAt: STARTED,
      command: COMMAND,
    });
    expect(verdict.missing).toEqual([expect.stringContaining('src/reports/export.ts')]);
  });

  it('задеты только ручные кейсы — прогона не требует, вердикт без кейсов', () => {
    const manual = testCase('auth-010', {
      codePaths: ['src/auth'],
      automation: { status: 'manual' },
    });
    const verdict = judgeTests({
      groups: groups([manual]),
      runs: [],
      paths: ['src/auth/login.ts'],
      startedAt: STARTED,
      command: COMMAND,
    });
    expect(verdict).toEqual({ missing: [], verdict: { cases: 0, passed: 0 } });
  });
});

import { describe, expect, it } from 'vitest';
import type { ProjectTestCase, ProjectTestGroup, ProjectTestRunRecord } from '@agentdeck/contracts';
import { judgeTests } from './tests-gate.ts';

/**
 * T2 (g5 25.10): пакет `inst-auth/internal/http` прошёл зелёным прогоном группы кейсов
 * `inst-users` на дереве 6a0acce27, а ворота требовали прогона кейса `suites-inst-auth-005`
 * с тем же автотестом — и тот же пакет гонялся ещё дважды. Зелёный того же automation
 * (файл + имя теста) на том же отпечатке дерева засчитывается, из любой группы.
 * P2: `runKeys` — ровно те кейсы, что названы командами пробелов, для `run --stale`.
 */

const STARTED = '2026-10-25T10:00:00.000Z';
const COMMAND = 'node tests-cli.mjs run --project .';
const TREE = 'tree-6a0acce27';

const auto = (id: string, file: string, testName?: string): ProjectTestCase =>
  ({
    id,
    type: 'case',
    title: id,
    steps: [],
    status: 'unknown',
    source: 'human',
    codePaths: ['inst-auth/internal/http'],
    automation: { status: 'automated', file, ...(testName ? { testName } : {}) },
  }) as ProjectTestCase;

const library = (users: ProjectTestCase[], suites: ProjectTestCase[]): ProjectTestGroup[] => [
  { id: 'inst-users', title: 'Users', file: 'inst-users.tests.json', cases: users },
  { id: 'suites', title: 'Suites', file: 'suites.tests.json', cases: suites },
];

const record = (
  id: string,
  startedAt: string,
  results: [string, string, 'passed' | 'failed'][],
  extra: Partial<ProjectTestRunRecord> = {},
): ProjectTestRunRecord =>
  ({
    id,
    mode: 'import',
    actor: 'ci',
    origin: 'e2e',
    status: 'done',
    startedAt,
    finishedAt: startedAt,
    results: results.map(([groupId, caseId, status]) => ({
      pointId: caseId,
      groupId,
      caseId,
      status,
    })),
    summary: { total: results.length, passed: 0, failed: 0, skipped: 0, blocked: 0 },
    ...extra,
  }) as ProjectTestRunRecord;

const usersCase = auto('inst-users-010', 'inst-auth/internal/http/');
const suiteCase = auto('suites-inst-auth-005', 'inst-auth/internal/http');
const judge = (runs: ProjectTestRunRecord[], tree: string | (() => string | undefined) = TREE) =>
  judgeTests({
    groups: library([usersCase], [suiteCase]),
    runs,
    paths: ['inst-auth/internal/http/handlers.go'],
    startedAt: STARTED,
    command: COMMAND,
    tree,
  });

describe('зелёный того же автотеста на том же дереве', () => {
  const green = record('r-users', '2026-10-25T10:58:00.000Z', [
    ['inst-users', 'inst-users-010', 'passed'],
  ]);

  it('прогон другой группы на этом дереве закрывает кейс с тем же automation', () => {
    const verdict = judge([{ ...green, tree: TREE }]);
    expect(verdict.missing).toEqual([]);
    expect(verdict.runKeys).toBeUndefined();
    expect(verdict.verdict).toMatchObject({ cases: 2, passed: 2 });
  });

  it('другое дерево, нет отпечатка, красный или слово — не засчитывается', () => {
    const other = judge([{ ...green, tree: 'tree-other' }]);
    expect(other.missing.join('\n')).toContain('suites-inst-auth-005');
    expect(other.runKeys).toEqual(['suites:suites-inst-auth-005']);
    expect(judge([green]).runKeys).toEqual(['suites:suites-inst-auth-005']);
    expect(judge([{ ...green, tree: TREE }], () => undefined).runKeys).toEqual([
      'suites:suites-inst-auth-005',
    ]);
    const red = record(
      'r-red',
      '2026-10-25T10:58:00.000Z',
      [['inst-users', 'inst-users-010', 'failed']],
      { tree: TREE },
    );
    expect(judge([red]).missing.join('\n')).toContain('suites-inst-auth-005');
    expect(judge([{ ...green, tree: TREE, attested: true }]).runKeys).toEqual([
      'inst-users:inst-users-010',
      'suites:suites-inst-auth-005',
    ]);
  });

  it('прогон до старта группы на том же дереве — тоже засчитан: исполнено то же', () => {
    const before = record(
      'r-before',
      '2026-10-25T09:00:00.000Z',
      [
        ['inst-users', 'inst-users-010', 'passed'],
        ['suites', 'suites-inst-auth-005', 'passed'],
      ],
      { tree: TREE },
    );
    expect(judge([before]).missing).toEqual([]);
  });

  it('другое имя теста — другой автотест, не засчитывается', () => {
    const named = auto('suites-inst-auth-006', 'inst-auth/internal/http', 'TestLogin');
    const verdict = judgeTests({
      groups: library([usersCase], [named]),
      runs: [{ ...green, tree: TREE }],
      paths: ['inst-auth/internal/http/handlers.go'],
      startedAt: STARTED,
      command: COMMAND,
      tree: TREE,
    });
    expect(verdict.runKeys).toEqual(['suites:suites-inst-auth-006']);
  });

  it('отпечаток снимается, только если есть что заимствовать', () => {
    let calls = 0;
    const lazy = () => {
      calls += 1;
      return TREE;
    };
    const both = record(
      'r-both',
      '2026-10-25T10:58:00.000Z',
      [
        ['inst-users', 'inst-users-010', 'passed'],
        ['suites', 'suites-inst-auth-005', 'passed'],
      ],
      { tree: TREE },
    );
    expect(judge([both], lazy).missing).toEqual([]);
    expect(calls).toBe(0);
    judge([{ ...green, tree: TREE }], lazy);
    expect(calls).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import type {
  ProjectTestCase,
  ProjectTestGroup,
  ProjectTestPointResult,
  ProjectTestRunRecord,
  ProjectTestStatus,
} from '@agentdeck/contracts';
import { judgeTurn } from '../../project-tests/turn-gate/turn-gate.ts';
import { judgeTests } from './tests-gate.ts';

/**
 * Правило «красное не из-за ветки» (решение владельца 23.10): живая группа
 * встала на inst-api-014 (красный только на Windows и до неё) и inst-docs-ui-003
 * (таймауты), хотя её дифф не задевал ни один из них. Такое — заметка на
 * карточку и в описание MR; красное, задетое диффом, держит по-прежнему.
 */

const STARTED = '2026-10-23T10:00:00.000Z';
const BEFORE = '2026-10-22T09:00:00.000Z';
const AFTER = '2026-10-23T10:30:00.000Z';
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
const api = testCase('inst-api-014', { codePaths: ['src/api'] });
const docs = testCase('inst-docs-ui-003', { codePaths: ['docs'] });

describe('красное не из-за ветки — заметка, а не пробел', () => {
  it('красный и до старта группы, дифф его не задел — заметка «красный и на основной»', () => {
    const verdict = judgeTests({
      groups: groups([users, api]),
      runs: [
        run('base', BEFORE, [['inst-api-014', 'failed']]),
        run('own', AFTER, [
          ['inst-users-001', 'passed'],
          ['inst-api-014', 'failed'],
        ]),
      ],
      paths: ['src/users/list.ts'],
      startedAt: STARTED,
      command: COMMAND,
    });
    expect(verdict.missing).toEqual([]);
    expect(verdict.notes).toEqual([expect.stringContaining('inst-api-014')]);
    expect(verdict.notes?.[0]).toContain('до старта группы');
    expect(verdict.noted).toEqual(['inst-api-014']);
  });

  it('упал по таймауту, дифф его не задел — заметка «окружение»', () => {
    const verdict = judgeTests({
      groups: groups([users, docs]),
      runs: [
        run('own', AFTER, [
          ['inst-users-001', 'passed'],
          [
            'inst-docs-ui-003',
            'failed',
            { failure: { actual: 'page.goto: Timeout 30000ms exceeded' } },
          ],
        ]),
      ],
      paths: ['src/users/list.ts'],
      startedAt: STARTED,
      command: COMMAND,
    });
    expect(verdict.missing).toEqual([]);
    expect(verdict.notes).toEqual([expect.stringContaining('inst-docs-ui-003')]);
    expect(verdict.notes?.[0]).toContain('окружения');
  });

  it('blocked (не смог выполниться) на незадетом кейсе — окружение', () => {
    const verdict = judgeTests({
      groups: groups([users, docs]),
      runs: [
        run('own', AFTER, [
          ['inst-users-001', 'passed'],
          ['inst-docs-ui-003', 'blocked'],
        ]),
      ],
      paths: ['src/users/list.ts'],
      startedAt: STARTED,
      command: COMMAND,
    });
    expect(verdict.missing).toEqual([]);
    expect(verdict.noted).toEqual(['inst-docs-ui-003']);
  });

  // Разбор групп 23.10, INST b: кейс, который здесь не выполнить (стенда нет),
  // держал доставку, раз дифф задел его codePaths, — хотя вердикта о коде нет.
  it('blocked на задетом диффом кейсе — тоже заметка, не пробел', () => {
    const verdict = judgeTests({
      groups: groups([users, docs]),
      runs: [
        run('own', AFTER, [
          ['inst-users-001', 'passed'],
          ['inst-docs-ui-003', 'blocked', { note: 'стенд с веткой не поднят' }],
        ]),
      ],
      paths: ['src/users/list.ts', 'docs/users.mdx', 'tests/inst-docs-ui-003.spec.ts'],
      startedAt: STARTED,
      command: COMMAND,
    });
    expect(verdict.missing).toEqual([]);
    expect(verdict.noted).toEqual(['inst-docs-ui-003']);
    expect(verdict.notes?.[0]).toContain('не выполнились (blocked)');
  });

  it('красный и до старта, но дифф задел его codePaths — держит: ветка могла сломать его сама', () => {
    const verdict = judgeTests({
      groups: groups([users, api]),
      runs: [
        run('base', BEFORE, [['inst-api-014', 'failed']]),
        run('own', AFTER, [
          ['inst-users-001', 'passed'],
          ['inst-api-014', 'failed', { note: 'Timeout' }],
        ]),
      ],
      paths: ['src/users/list.ts', 'src/api/handler.ts'],
      startedAt: STARTED,
      command: COMMAND,
    });
    expect(verdict.missing).toEqual([expect.stringContaining('inst-api-014')]);
    expect(verdict.notes).toBeUndefined();
  });

  it('дифф изменил файл автотеста кейса — держит, даже по таймауту', () => {
    const verdict = judgeTests({
      groups: groups([users, docs]),
      runs: [
        run('own', AFTER, [
          ['inst-users-001', 'passed'],
          ['inst-docs-ui-003', 'failed', { note: 'timed out' }],
        ]),
      ],
      paths: ['src/users/list.ts', 'tests/inst-docs-ui-003.spec.ts'],
      startedAt: STARTED,
      command: COMMAND,
    });
    expect(verdict.missing).toEqual([expect.stringContaining('inst-docs-ui-003')]);
  });

  it('незадетый красный без истории и без признаков окружения — держит: доказать нечем', () => {
    const verdict = judgeTests({
      groups: groups([users, api]),
      runs: [
        run('own', AFTER, [
          ['inst-users-001', 'passed'],
          ['inst-api-014', 'failed', { note: 'expected 200, got 500' }],
        ]),
      ],
      paths: ['src/users/list.ts'],
      startedAt: STARTED,
      command: COMMAND,
    });
    expect(verdict.missing).toEqual([expect.stringContaining('inst-api-014')]);
  });

  // F-22: слово агента (`tests-cli record … =blocked`) после исполненного
  // красного снимало пробел — ветка с красным тестом уезжала в MR.
  it('исполненный красный не перекрывается поздней записью словом blocked', () => {
    const word = run('word', '2026-10-23T10:40:00.000Z', [['inst-api-014', 'blocked']]);
    const verdict = judgeTests({
      groups: groups([users, api]),
      runs: [
        run('own', AFTER, [
          ['inst-users-001', 'passed'],
          ['inst-api-014', 'failed', { note: 'expected 200, got 500' }],
        ]),
        { ...word, attested: true },
      ],
      paths: ['src/users/list.ts', 'src/api/handler.ts'],
      startedAt: STARTED,
      command: COMMAND,
    });
    expect(verdict.missing).toEqual([expect.stringContaining('inst-api-014')]);
    expect(verdict.noted).toBeUndefined();
  });

  // RF-EF-03: обратный порядок — исполненный зелёный, потом красное словом.
  // `ran ?? word` брал зелёный и прятал красное; конец хода (`turn-gate`) на том
  // же входе держал — ворота расходились.
  it('красная запись словом после исполненного зелёного — держит, как и конец хода', () => {
    const word = run('word', '2026-10-23T10:40:00.000Z', [['inst-users-001', 'failed']]);
    const runs = [run('own', AFTER, [['inst-users-001', 'passed']]), { ...word, attested: true }];
    const verdict = judgeTests({
      groups: groups([users]),
      runs,
      paths: ['src/users/list.ts'],
      startedAt: STARTED,
      command: COMMAND,
    });
    expect(verdict.missing).toEqual([expect.stringContaining('inst-users-001')]);
    const turn = judgeTurn({
      groups: groups([users]),
      runs,
      paths: ['src/users/list.ts'],
      since: STARTED,
      cli: 'node tests-cli.mjs',
      root: '.',
    });
    expect(turn).toEqual(
      expect.arrayContaining([expect.stringMatching(/red this turn \(inst:inst-users-001\)/)]),
    );
  });

  // F-43: у кейса без codePaths не видно, задел ли дифф его код, — «timed out»
  // мог дать сам повисший код ветки.
  it('кейс без codePaths, красный по таймауту, — держит: незадетость не доказать', () => {
    const loose = testCase('inst-loose-001', { automation: { status: 'automated' } });
    const verdict = judgeTests({
      groups: groups([users, loose]),
      runs: [
        run('own', AFTER, [
          ['inst-users-001', 'passed'],
          ['inst-loose-001', 'failed', { note: 'timed out' }],
        ]),
      ],
      paths: ['src/users/list.ts'],
      startedAt: STARTED,
      command: COMMAND,
    });
    expect(verdict.missing).toEqual([expect.stringContaining('inst-loose-001')]);
    expect(verdict.notes).toBeUndefined();
  });

  it('снят по пределу tests-cli («Предел времени»), дифф не задел — заметка «окружение»', () => {
    const cap = 'Предел времени: прогон шёл 600 с, предел 10 мин. Дерево процессов прогона снято.';
    const verdict = judgeTests({
      groups: groups([users, docs]),
      runs: [
        run('own', AFTER, [
          ['inst-users-001', 'passed'],
          ['inst-docs-ui-003', 'failed', { note: cap }],
        ]),
      ],
      paths: ['src/users/list.ts'],
      startedAt: STARTED,
      command: COMMAND,
    });
    expect(verdict.missing).toEqual([]);
    expect(verdict.noted).toEqual(['inst-docs-ui-003']);
  });
});

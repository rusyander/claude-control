import type {
  ProjectTestCase,
  ProjectTestCoverage,
  ProjectTestGroup,
  ProjectTestPointResult,
  ProjectTestRunRecord,
  ProjectTestStatus,
} from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import { buildRelease, releaseNames } from './release.ts';

/**
 * Документ готовности вехи.
 *
 * Главное свойство — документ судит по прогонам ВЕХИ, а не по текущим статусам
 * кейсов: кейс, позеленевший в соседней ветке, готовность релиза не улучшает.
 * Второе — вердикт называет причины поимённо и ничего не подписывает.
 */

const testCase = (id: string, over: Partial<ProjectTestCase> = {}): ProjectTestCase => ({
  id,
  title: `Кейс ${id}`,
  type: 'case',
  status: 'unknown',
  source: 'human',
  steps: [],
  ...over,
});

const group = (id: string, cases: ProjectTestCase[]): ProjectTestGroup => ({
  id,
  title: `Группа ${id}`,
  file: `${id}.tests.json`,
  cases,
});

const result = (
  caseId: string,
  status: ProjectTestStatus,
  over: Partial<ProjectTestPointResult> = {},
): ProjectTestPointResult => ({
  pointId: `gui:${caseId}`,
  groupId: 'gui',
  caseId,
  status,
  ...over,
});

const run = (
  id: string,
  release: string | undefined,
  results: ProjectTestPointResult[],
  startedAt = '2026-09-08T10:00:00.000Z',
): ProjectTestRunRecord => ({
  id,
  mode: 'run',
  actor: 'agent',
  status: 'done',
  release,
  startedAt,
  finishedAt: startedAt,
  results,
  summary: {
    total: results.length,
    passed: results.filter((one) => one.status === 'passed').length,
    failed: results.filter((one) => one.status === 'failed').length,
    skipped: results.filter((one) => one.status === 'skipped').length,
    blocked: results.filter((one) => one.status === 'blocked').length,
  },
});

const NOW = '2026-09-08T12:00:00.000Z';

describe('project-tests/release: что считается проверенным', () => {
  it('кейс, которого веха не трогала, идёт в непроверенные', () => {
    const groups = [group('gui', [testCase('a'), testCase('b')])];
    const runs = [run('r1', '1.4', [result('a', 'passed')])];

    const doc = buildRelease('1.4', groups, runs, { now: NOW });

    expect(doc.totals.cases).toBe(2);
    expect(doc.totals.passed).toBe(1);
    expect(doc.untested.map((item) => item.caseId)).toEqual(['b']);
    expect(doc.verdict.ready).toBe(false);
    expect(doc.verdict.blockers).toContain('Не проверено кейсов: 1 из 2.');
  });

  it('зелёный прогон ЧУЖОЙ вехи готовности не улучшает', () => {
    const groups = [group('gui', [testCase('a')])];
    const runs = [
      run('r2', '1.5', [result('a', 'passed')], '2026-09-08T11:00:00.000Z'),
      run('r1', '1.4', [result('a', 'failed')]),
    ];

    const doc = buildRelease('1.4', groups, runs, { now: NOW });

    expect(doc.totals.failed).toBe(1);
    expect(doc.red.map((item) => item.caseId)).toEqual(['a']);
    expect(doc.totals.runs).toBe(1);
  });

  it('перепройденный кейс идёт в документ второй попыткой, а не первой', () => {
    const groups = [group('gui', [testCase('a')])];
    const runs = [
      run('r2', '1.4', [result('a', 'passed')], '2026-09-08T11:00:00.000Z'),
      run('r1', '1.4', [result('a', 'failed')]),
    ];

    const doc = buildRelease('1.4', groups, runs, { now: NOW });

    expect(doc.totals.passed).toBe(1);
    expect(doc.red).toEqual([]);
  });

  it('архивный кейс не считается ни проверенным, ни непроверенным', () => {
    const groups = [group('gui', [testCase('a'), testCase('old', { archived: true })])];
    const runs = [run('r1', '1.4', [result('a', 'passed')])];

    const doc = buildRelease('1.4', groups, runs, { now: NOW });

    expect(doc.totals.cases).toBe(1);
    expect(doc.untested).toEqual([]);
  });

  it('прогонов вехи нет — вердикт говорит об этом первой строкой', () => {
    const doc = buildRelease('2.0', [group('gui', [testCase('a')])], [], { now: NOW });

    expect(doc.totals.runs).toBe(0);
    expect(doc.verdict.blockers[0]).toBe('Прогонов вехи нет: проверять нечего.');
  });
});

describe('project-tests/release: карантин и вердикт', () => {
  it('провал кейса в карантине вердикт не красит, но назван вслух', () => {
    const groups = [
      group('gui', [testCase('a', { muted: true, muteReason: 'ждём починки логина' })]),
    ];
    const runs = [run('r1', '1.4', [result('a', 'failed')])];

    const doc = buildRelease('1.4', groups, runs, { now: NOW });

    expect(doc.totals.failed).toBe(0);
    expect(doc.totals.muted).toBe(1);
    expect(doc.red).toEqual([]);
    expect(doc.muted.map((item) => item.caseId)).toEqual(['a']);
    expect(doc.verdict.ready).toBe(true);
    expect(doc.verdict.text).toContain('В карантине 1');
  });

  it('всё зелёное и без дефектов — вердикт готов, список причин пуст', () => {
    const groups = [group('gui', [testCase('a')])];
    const runs = [run('r1', '1.4', [result('a', 'passed')])];

    const doc = buildRelease('1.4', groups, runs, { now: NOW });

    expect(doc.verdict.ready).toBe(true);
    expect(doc.verdict.blockers).toEqual([]);
  });

  it('провалы идут от важного к остальному', () => {
    const groups = [
      group('gui', [
        testCase('low', { priority: 'low' }),
        testCase('stop', { priority: 'blocker' }),
        testCase('mid', { priority: 'medium' }),
      ]),
    ];
    const runs = [
      run('r1', '1.4', [
        result('low', 'failed'),
        result('stop', 'failed'),
        result('mid', 'blocked'),
      ]),
    ];

    const doc = buildRelease('1.4', groups, runs, { now: NOW });

    expect(doc.red.map((item) => item.caseId)).toEqual(['stop', 'mid', 'low']);
    expect(doc.totals.failed).toBe(2);
    expect(doc.totals.blocked).toBe(1);
  });
});

describe('project-tests/release: дефекты', () => {
  it('незакрытым считается всё, кроме прямого closed', () => {
    const groups = [
      group('gui', [
        testCase('a', {
          defects: [
            { url: 'https://jira/browse/QA-1', state: 'open', title: 'Вход падает' },
            { url: 'https://jira/browse/QA-2', state: 'closed' },
            { url: 'https://jira/browse/QA-3' },
          ],
        }),
      ]),
    ];
    const runs = [run('r1', '1.4', [result('a', 'passed')])];

    const doc = buildRelease('1.4', groups, runs, { now: NOW });

    expect(doc.defects.map((item) => item.key ?? item.url)).toEqual([
      'https://jira/browse/QA-1',
      'https://jira/browse/QA-3',
    ]);
    expect(doc.defects[1]?.state).toBe('unknown');
    expect(doc.verdict.blockers).toContain('Незакрытых дефектов: 2.');
  });

  it('дефекты архивного кейса релиз не держат', () => {
    const groups = [
      group('gui', [
        testCase('old', { archived: true, defects: [{ url: 'https://jira/browse/QA-9' }] }),
      ]),
    ];

    const doc = buildRelease('1.4', groups, [run('r1', '1.4', [])], { now: NOW });

    expect(doc.defects).toEqual([]);
  });
});

describe('project-tests/release: требования', () => {
  const coverage = (items: ProjectTestCoverage['items']): ProjectTestCoverage => ({
    items,
    orphans: [],
    source: 'links',
  });

  it('состояние требования считается по прогонам вехи, а не по статусу кейса', () => {
    const groups = [group('gui', [testCase('a', { status: 'passed' }), testCase('b')])];
    const runs = [run('r1', '1.4', [result('a', 'failed')])];
    const matrix = coverage([
      {
        key: 'QA-1',
        cases: [
          { groupId: 'gui', caseId: 'a', title: 'Кейс a', status: 'passed' },
          { groupId: 'gui', caseId: 'b', title: 'Кейс b', status: 'unknown' },
        ],
        counts: { passed: 1, failed: 0, blocked: 0, skipped: 0, unknown: 1 },
      },
    ]);

    const doc = buildRelease('1.4', groups, runs, { now: NOW, coverage: matrix });

    expect(doc.requirements[0]).toMatchObject({
      key: 'QA-1',
      cases: 2,
      passed: 0,
      failed: 1,
      untested: 1,
      state: 'red',
    });
  });

  it('требование без кейсов остаётся в документе и идёт первым', () => {
    const groups = [group('gui', [testCase('a')])];
    const runs = [run('r1', '1.4', [result('a', 'passed')])];
    const matrix = coverage([
      {
        key: 'QA-2',
        cases: [{ groupId: 'gui', caseId: 'a', title: 'Кейс a', status: 'passed' }],
        counts: { passed: 1, failed: 0, blocked: 0, skipped: 0, unknown: 0 },
      },
      {
        key: 'QA-1',
        cases: [],
        counts: { passed: 0, failed: 0, blocked: 0, skipped: 0, unknown: 0 },
      },
    ]);

    const doc = buildRelease('1.4', groups, runs, { now: NOW, coverage: matrix });

    expect(doc.requirements.map((item) => item.key)).toEqual(['QA-1', 'QA-2']);
    expect(doc.requirements[1]?.state).toBe('covered');
  });

  it('оговорка матрицы переезжает в документ', () => {
    const doc = buildRelease('1.4', [], [run('r1', '1.4', [])], {
      now: NOW,
      coverage: { items: [], orphans: [], source: 'links', warning: 'Atlassian не подключён.' },
    });

    expect(doc.warning).toBe('Atlassian не подключён.');
    expect(doc.requirements).toEqual([]);
  });
});

describe('project-tests/release: список вех', () => {
  it('вехи идут от свежей к старой и без повторов', () => {
    const runs = [
      run('r3', '1.5', [], '2026-09-08T12:00:00.000Z'),
      run('r2', undefined, [], '2026-09-08T11:00:00.000Z'),
      run('r1', '1.4', [], '2026-09-08T10:00:00.000Z'),
      run('r0', '1.5', [], '2026-09-07T10:00:00.000Z'),
    ];

    expect(releaseNames(runs)).toEqual(['1.5', '1.4']);
  });
});

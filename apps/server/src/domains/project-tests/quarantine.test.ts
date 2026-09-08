import type {
  ProjectTestCase,
  ProjectTestGroup,
  ProjectTestPointResult,
  ProjectTestRunRecord,
  ProjectTestStatus,
} from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import { buildQuarantine } from './quarantine.ts';

/**
 * Карантин и устаревание.
 *
 * Главное свойство — предложение остаётся предложением: отчёт называет кейс,
 * порог и причину, но библиотеку не трогает. Второе — пороги считаются по
 * истории, а не по последнему прогону: кейс, зелёный один раз, из карантина не
 * выходит.
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

/** Прогоны от новых к старым — ровно так их отдаёт хранилище. */
const historyOf = (caseId: string, statuses: ProjectTestStatus[]): ProjectTestRunRecord[] =>
  statuses
    .map((status, index) => {
      const result: ProjectTestPointResult = {
        pointId: `gui:${caseId}`,
        groupId: 'gui',
        caseId,
        status,
      };
      return {
        id: `run-${index}`,
        mode: 'run' as const,
        actor: 'agent' as const,
        status: 'done' as const,
        startedAt: `2026-09-0${index + 1}T10:00:00.000Z`,
        finishedAt: `2026-09-0${index + 1}T10:10:00.000Z`,
        results: [result],
        summary: {
          total: 1,
          passed: status === 'passed' ? 1 : 0,
          failed: status === 'failed' ? 1 : 0,
          skipped: status === 'skipped' ? 1 : 0,
          blocked: status === 'blocked' ? 1 : 0,
        },
      };
    })
    .reverse();

const NOW = '2026-09-08T12:00:00.000Z';

describe('project-tests/quarantine: снятие карантина', () => {
  it('предлагает снять карантин после N зелёных подряд', () => {
    const groups = [
      group('gui', [testCase('a', { muted: true, muteReason: 'ждём починки логина' })]),
    ];
    const runs = historyOf('a', ['failed', 'passed', 'passed', 'passed', 'passed', 'passed']);

    const report = buildQuarantine(groups, runs, { updates: {} }, { now: NOW });

    expect(report.lift).toHaveLength(1);
    expect(report.lift[0]?.caseId).toBe('a');
    expect(report.lift[0]?.greenStreak).toBe(5);
    expect(report.lift[0]?.muteReason).toBe('ждём починки логина');
    expect(report.lift[0]?.message).toContain('5');
  });

  it('молчит, пока зелёных подряд меньше порога', () => {
    const groups = [group('gui', [testCase('a', { muted: true })])];
    const runs = historyOf('a', ['failed', 'passed', 'passed', 'passed']);

    expect(buildQuarantine(groups, runs, { updates: {} }, { now: NOW }).lift).toHaveLength(0);
  });

  it('провал рвёт серию, а пропуск — нет', () => {
    const groups = [group('gui', [testCase('a', { muted: true })])];
    const broken = historyOf('a', ['passed', 'passed', 'failed', 'passed', 'passed', 'passed']);
    const skipped = historyOf('a', ['passed', 'passed', 'skipped', 'passed', 'passed', 'passed']);

    expect(buildQuarantine(groups, broken, { updates: {} }, { now: NOW }).lift).toHaveLength(0);
    expect(buildQuarantine(groups, skipped, { updates: {} }, { now: NOW }).lift).toHaveLength(1);
  });

  it('порог задаётся снаружи', () => {
    const groups = [group('gui', [testCase('a', { muted: true })])];
    const runs = historyOf('a', ['passed', 'passed']);

    const report = buildQuarantine(groups, runs, { updates: {} }, { now: NOW, greenStreak: 2 });
    expect(report.lift).toHaveLength(1);
    expect(report.thresholds.greenStreak).toBe(2);
  });
});

describe('project-tests/quarantine: постановка карантина', () => {
  it('предлагает карантин нестабильному кейсу и подставляет причину', () => {
    const groups = [group('gui', [testCase('a')])];
    const runs = historyOf('a', ['passed', 'failed', 'passed', 'failed', 'passed']);

    const report = buildQuarantine(groups, runs, { updates: {} }, { now: NOW });

    expect(report.quarantine).toHaveLength(1);
    expect(report.quarantine[0]?.stability).toBe(0);
    expect(report.quarantine[0]?.reason).toContain('Нестабилен');
    expect(report.quarantine[0]?.runs).toBe(5);
  });

  it('не судит по одному-двум прогонам', () => {
    const groups = [group('gui', [testCase('a')])];
    const runs = historyOf('a', ['passed', 'failed']);

    expect(buildQuarantine(groups, runs, { updates: {} }, { now: NOW }).quarantine).toHaveLength(0);
  });

  it('стабильный кейс в предложениях не появляется', () => {
    const groups = [group('gui', [testCase('a')])];
    const runs = historyOf('a', ['passed', 'passed', 'passed', 'passed', 'failed']);

    const report = buildQuarantine(groups, runs, { updates: {} }, { now: NOW });
    expect(report.quarantine).toHaveLength(0);
  });

  it('кейс в карантине второй раз не выключается', () => {
    const groups = [group('gui', [testCase('a', { muted: true })])];
    const runs = historyOf('a', ['passed', 'failed', 'passed', 'failed', 'passed']);

    const report = buildQuarantine(groups, runs, { updates: {} }, { now: NOW });
    expect(report.quarantine).toHaveLength(0);
    expect(report.lift).toHaveLength(0);
  });

  it('архивные кейсы и нечитаемые группы пропускаются', () => {
    const broken: ProjectTestGroup = {
      ...group('bad', [testCase('a')]),
      error: 'файл не разобран',
    };
    const groups = [group('gui', [testCase('a', { archived: true })]), broken];
    const runs = historyOf('a', ['passed', 'failed', 'passed', 'failed', 'passed']);

    const report = buildQuarantine(groups, runs, { updates: {} }, { now: NOW });
    expect(report.quarantine).toHaveLength(0);
  });
});

describe('project-tests/quarantine: расхождение с требованием', () => {
  const linked = (over: Partial<ProjectTestCase> = {}) =>
    testCase('a', {
      updatedAt: '2026-08-01T00:00:00.000Z',
      links: [{ type: 'requirement', url: 'https://jira.example/browse/QA-42' }],
      ...over,
    });

  it('называет кейс, у которого требование правили позже', () => {
    const report = buildQuarantine(
      [group('gui', [linked()])],
      [],
      { updates: { 'QA-42': { updatedAt: '2026-09-01T00:00:00.000Z' } } },
      { now: NOW },
    );

    expect(report.stale).toHaveLength(1);
    expect(report.stale[0]?.key).toBe('QA-42');
    expect(report.stale[0]?.days).toBe(31);
    expect(report.stale[0]?.url).toBe('https://jira.example/browse/QA-42');
  });

  it('требование старше кейса расхождением не считается', () => {
    const report = buildQuarantine(
      [group('gui', [linked()])],
      [],
      { updates: { 'QA-42': { updatedAt: '2026-07-01T00:00:00.000Z' } } },
      { now: NOW },
    );
    expect(report.stale).toHaveLength(0);
  });

  it('кейс без собственной даты правки не обвиняется', () => {
    const report = buildQuarantine(
      [group('gui', [linked({ updatedAt: undefined })])],
      [],
      { updates: { 'QA-42': { updatedAt: '2026-09-01T00:00:00.000Z' } } },
      { now: NOW },
    );
    expect(report.stale).toHaveLength(0);
  });

  it('оговорка трекера доезжает до отчёта, а предложения по карантину остаются', () => {
    const groups = [group('gui', [testCase('a', { muted: true })])];
    const runs = historyOf('a', ['passed', 'passed', 'passed', 'passed', 'passed']);

    const report = buildQuarantine(
      groups,
      runs,
      { updates: {}, warning: 'Atlassian не подключён: даты требований не сверялись.' },
      { now: NOW },
    );

    expect(report.warning).toContain('Atlassian');
    expect(report.lift).toHaveLength(1);
    expect(report.stale).toHaveLength(0);
  });
});

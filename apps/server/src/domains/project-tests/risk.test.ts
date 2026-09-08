import type {
  ProjectTestCase,
  ProjectTestGroup,
  ProjectTestImpact,
  ProjectTestPointResult,
  ProjectTestRunRecord,
  ProjectTestStatus,
} from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import { buildRisk, byRisk, budgetOf, riskOfCase } from './risk.ts';

/**
 * Риск и время.
 *
 * Проверяется не «число получилось», а порядок и его объяснимость: что кейс,
 * падавший вчера, стоит выше зелёного; что кейс без истории не проваливается в
 * ноль; что бюджет никогда не переполняется и вслух называет невлезшее.
 */

const NOW = '2026-09-08T12:00:00.000Z';

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
const runsOf = (caseId: string, statuses: ProjectTestStatus[]): ProjectTestRunRecord[] =>
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

const scoreOf = (testCaseInput: ProjectTestCase, over: Parameters<typeof riskOfCase>[2] = {}) =>
  riskOfCase('gui', testCaseInput, { now: Date.parse(NOW), ...over }).score;

describe('риск кейса', () => {
  it('считается пятью множителями, и все они названы', () => {
    const item = riskOfCase('gui', testCase('a', { priority: 'high', status: 'failed' }), {
      now: Date.parse(NOW),
    });

    expect(item.factors.map((factor) => factor.key)).toEqual([
      'priority',
      'outcome',
      'instability',
      'age',
      'impact',
    ]);
    // Произведение множителей × 100 — ровно то, что описано в шапке модуля.
    const product = item.factors.reduce((total, factor) => total * factor.value, 100);
    expect(item.score).toBe(Math.round(product));
    for (const factor of item.factors) expect(factor.note.length).toBeGreaterThan(0);
  });

  it('красный кейс рискованнее зелёного при прочих равных', () => {
    const red = testCase('a', { priority: 'high', status: 'failed', lastRunAt: NOW });
    const green = testCase('b', { priority: 'high', status: 'passed', lastRunAt: NOW });
    expect(scoreOf(red)).toBeGreaterThan(scoreOf(green));
  });

  it('блокер рискованнее мелочи при одинаковой истории', () => {
    const blocker = testCase('a', { priority: 'blocker', status: 'passed', lastRunAt: NOW });
    const low = testCase('b', { priority: 'low', status: 'passed', lastRunAt: NOW });
    expect(scoreOf(blocker)).toBeGreaterThan(scoreOf(low));
  });

  it('кейс без истории не получает нулевой риск', () => {
    const fresh = testCase('a', { priority: 'low', status: 'unknown' });
    const item = riskOfCase('gui', fresh, { now: Date.parse(NOW) });

    expect(item.score).toBeGreaterThan(0);
    // Незнание дороже зелёной истории: непроверенная мелочь обгоняет
    // проверенную сегодня мелочь того же приоритета.
    const known = testCase('b', { priority: 'low', status: 'passed', lastRunAt: NOW });
    expect(item.score).toBeGreaterThan(scoreOf(known, { statuses: ['passed', 'passed'] }));
  });

  it('давность растёт до месяца и дальше не растёт', () => {
    const week = testCase('a', { status: 'passed', lastRunAt: '2026-09-01T12:00:00.000Z' });
    const month = testCase('b', { status: 'passed', lastRunAt: '2026-08-01T12:00:00.000Z' });
    const year = testCase('c', { status: 'passed', lastRunAt: '2025-09-08T12:00:00.000Z' });

    expect(scoreOf(month)).toBeGreaterThan(scoreOf(week));
    expect(scoreOf(year)).toBe(scoreOf(month));
  });

  it('нестабильный кейс рискованнее ровного', () => {
    const flip = ['passed', 'failed', 'passed', 'failed'];
    const flat = ['passed', 'passed', 'passed', 'passed'];
    const item = testCase('a', { status: 'passed', lastRunAt: NOW });

    expect(scoreOf(item, { statuses: flip })).toBeGreaterThan(scoreOf(item, { statuses: flat }));
  });

  it('карантин опускает кейс, но не обнуляет его', () => {
    const muted = testCase('a', { priority: 'blocker', status: 'failed', muted: true });
    const normal = testCase('b', { priority: 'blocker', status: 'failed' });

    expect(scoreOf(muted)).toBeLessThan(scoreOf(normal));
    expect(scoreOf(muted)).toBeGreaterThan(0);
  });

  it('попадание в дифф поднимает кейс и объясняется причиной отбора', () => {
    const item = testCase('a', { status: 'passed', lastRunAt: NOW });
    const hit = riskOfCase('gui', item, {
      now: Date.parse(NOW),
      impactReason: 'изменён src/App.tsx',
    });

    expect(hit.score).toBeGreaterThan(scoreOf(item));
    expect(hit.factors.find((factor) => factor.key === 'impact')?.note).toContain('src/App.tsx');
  });

  it('длительность без своей оценки помечается допущением', () => {
    const guessed = riskOfCase('gui', testCase('a'), { now: Date.parse(NOW) });
    const own = riskOfCase('gui', testCase('b', { duration: 12 }), { now: Date.parse(NOW) });

    expect(guessed.duration).toBe(5);
    expect(guessed.hasDuration).toBe(false);
    expect(own.duration).toBe(12);
    expect(own.hasDuration).toBe(true);
  });
});

describe('порядок и отчёт', () => {
  it('сортирует по убыванию риска, при равенстве — короткое вперёд', () => {
    const long = riskOfCase('gui', testCase('a', { duration: 30 }), { now: Date.parse(NOW) });
    const short = riskOfCase('gui', testCase('b', { duration: 3 }), { now: Date.parse(NOW) });

    expect([long, short].sort(byRisk)[0]?.caseId).toBe('b');
  });

  it('собирает отчёт по библиотеке, минуя архив и сломанные группы', () => {
    const broken: ProjectTestGroup = { ...group('e2e', []), error: 'битый JSON' };
    const report = buildRisk(
      [group('gui', [testCase('a'), testCase('b', { archived: true })]), broken],
      [],
      { now: NOW },
    );

    expect(report.items.map((item) => item.caseId)).toEqual(['a']);
    expect(report.checkedAt).toBe(NOW);
    expect(report.budget).toBeUndefined();
  });

  it('учитывает историю прогонов и дифф рабочей копии', () => {
    const impact: ProjectTestImpact = {
      files: ['src/App.tsx'],
      cases: [{ groupId: 'gui', caseId: 'b', title: 'Кейс b', reason: 'изменён src/App.tsx' }],
    };
    const report = buildRisk(
      [group('gui', [testCase('a', { status: 'passed' }), testCase('b', { status: 'passed' })])],
      runsOf('a', ['passed', 'failed', 'passed', 'failed']),
      { now: NOW, impact },
    );

    expect(report.changedFiles).toEqual(['src/App.tsx']);
    const hit = report.items.find((item) => item.caseId === 'b');
    expect(hit?.reason).toContain('задет правками');
    const flaky = report.items.find((item) => item.caseId === 'a');
    expect(flaky?.factors.find((factor) => factor.key === 'instability')?.note).toContain(
      'стабильность',
    );
  });

  it('считает только открытую группу, когда её назвали', () => {
    const report = buildRisk([group('gui', [testCase('a')]), group('e2e', [testCase('c')])], [], {
      now: NOW,
      groupId: 'e2e',
    });
    expect(report.items.map((item) => item.caseId)).toEqual(['c']);
  });
});

describe('«у меня N минут»', () => {
  const items = [
    riskOfCase('gui', testCase('a', { duration: 20, status: 'failed' })),
    riskOfCase('gui', testCase('b', { duration: 7, status: 'failed' })),
    riskOfCase('gui', testCase('c', { duration: 4, status: 'failed' })),
  ];

  it('не переполняет бюджет и называет невлезшее', () => {
    const budget = budgetOf(items, 25);

    expect(budget.minutes).toBeLessThanOrEqual(25);
    expect(budget.picked).toEqual(['gui:a', 'gui:c']);
    expect(budget.left.map((item) => item.key)).toEqual(['gui:b']);
    expect(budget.left[0]?.title).toBe('Кейс b');
  });

  it('продолжает перебор после невлезшего кейса', () => {
    // Первый кейс не влезает целиком, но остаток бюджета набирается короткими —
    // иначе «у меня 10 минут» отдавало бы пустой список при длинном лидере.
    const budget = budgetOf(items, 11);

    expect(budget.picked).toEqual(['gui:b', 'gui:c']);
    expect(budget.minutes).toBe(11);
  });

  it('приезжает в отчёт, когда бюджет спросили', () => {
    const report = buildRisk([group('gui', [testCase('a', { duration: 40 })])], [], {
      now: NOW,
      budget: 10,
    });

    expect(report.budget?.budget).toBe(10);
    expect(report.budget?.picked).toEqual([]);
    expect(report.budget?.left).toHaveLength(1);
    expect(report.budget?.minutes).toBe(0);
  });
});

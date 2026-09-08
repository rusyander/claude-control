import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ProjectTestCase,
  ProjectTestCoverage,
  ProjectTestGroup,
  ProjectTestImpact,
  ProjectTestPlanRecipe,
  ProjectTestPointResult,
  ProjectTestRunRecord,
  ProjectTestStatus,
} from '@agentdeck/contracts';
import {
  DEFAULT_CASE_DURATION,
  buildPlanPreview,
  toPlan,
  type PlanRecipeInput,
} from './plan-recipes.ts';
import { planCases, readPlans, savePlan } from './plans.ts';

/**
 * Сборка плана правилом.
 *
 * Проверяется то, ради чего правило вообще заменило агента: бюджет соблюдается
 * ровно, каждая строка «не влезло» объясняет себя, отбор повторяем, а результат
 * — обычный план, который сохраняет уже существующий `savePlan`.
 */

function testCase(over: Partial<ProjectTestCase> = {}): ProjectTestCase {
  return {
    id: 'gui-001',
    type: 'case',
    title: 'Вход с верными данными',
    steps: [],
    status: 'unknown',
    source: 'human',
    ...over,
  };
}

function group(id: string, cases: ProjectTestCase[]): ProjectTestGroup {
  return { id, title: id.toUpperCase(), file: `.agent/tests/${id}.tests.json`, cases };
}

function result(caseId: string, status: ProjectTestStatus): ProjectTestPointResult {
  return { pointId: `gui|${caseId}`, groupId: 'gui', caseId, status };
}

function runRecord(
  id: string,
  results: ProjectTestPointResult[],
  release?: string,
): ProjectTestRunRecord {
  return {
    id,
    mode: 'run',
    actor: 'agent',
    status: 'done',
    startedAt: '2026-09-08T10:00:00.000Z',
    release,
    results,
    summary: { total: results.length, passed: 0, failed: 0, skipped: 0, blocked: 0 },
  };
}

/** История по кейсам: i-й прогон получает i-й статус каждого кейса. */
function runsOf(
  history: { caseId: string; statuses: ProjectTestStatus[] }[],
): ProjectTestRunRecord[] {
  const length = Math.max(...history.map((row) => row.statuses.length));
  const runs: ProjectTestRunRecord[] = [];
  for (let index = 0; index < length; index += 1) {
    const results: ProjectTestPointResult[] = [];
    for (const row of history) {
      const status = row.statuses[index];
      if (status) results.push(result(row.caseId, status));
    }
    runs.push(runRecord(`r${index}`, results));
  }
  // История отдаётся от новых к старым — так её читает и `readRuns`.
  return runs.reverse();
}

function preview(input: PlanRecipeInput) {
  return buildPlanPreview(input);
}

describe('project-tests/plan-recipes: дым', () => {
  const groups = [
    group('gui', [
      testCase({ id: 'gui-001', title: 'Вход', priority: 'blocker', duration: 10 }),
      testCase({ id: 'gui-002', title: 'Отправка', priority: 'high', duration: 10 }),
      testCase({ id: 'gui-003', title: 'Полный регресс чата', priority: 'high', duration: 25 }),
      testCase({ id: 'gui-004', title: 'Подсказка', priority: 'low', duration: 10 }),
    ]),
  ];

  it('бюджет соблюдается ровно, а длинный кейс уступает место коротким', () => {
    const plan = preview({ recipe: 'smoke', budget: 30, groups });

    expect(plan.minutes).toBe(30);
    expect(plan.budget).toBe(30);
    expect(plan.picked.map((pick) => pick.caseId)).toEqual(['gui-001', 'gui-002', 'gui-004']);
    // Не влезший кейс объясняет себя цифрами, а не словом «пропущен».
    expect(plan.left).toHaveLength(1);
    expect(plan.left[0]?.caseId).toBe('gui-003');
    expect(plan.left[0]?.reason).toBe('не влез в бюджет 30 мин: набрано 20, кейс просит 25');
  });

  it('порядок задаёт риск, а не одна важность; карантин уходит последним', () => {
    const order = preview({
      recipe: 'smoke',
      budget: 100,
      groups: [
        group('gui', [
          testCase({ id: 'gui-001', title: 'Зелёный', priority: 'high', status: 'passed' }),
          testCase({ id: 'gui-002', title: 'Красный', priority: 'high', status: 'failed' }),
          testCase({
            id: 'gui-003',
            title: 'Известная поломка',
            priority: 'high',
            status: 'failed',
            muted: true,
          }),
          testCase({ id: 'gui-004', title: 'Непроверенный', priority: 'high' }),
          testCase({ id: 'gui-005', title: 'Главное', priority: 'blocker', status: 'passed' }),
        ]),
      ],
    });

    // Красный «high» обгоняет зелёный «blocker»: это и есть смысл риска —
    // важность говорит, насколько кейс важен вообще, история — насколько
    // он важен сегодня.
    expect(order.picked.map((pick) => pick.caseId)).toEqual([
      'gui-002',
      'gui-004',
      'gui-005',
      'gui-001',
      'gui-003',
    ]);
    expect(order.picked[0]?.reason).toContain('последний прогон красный');
    expect(order.picked[1]?.reason).toContain('ещё не проверялся');
    expect(order.picked[4]?.reason).toContain('в карантине');
  });

  it('кейс без длительности считается по документированной оценке', () => {
    const plan = preview({ recipe: 'smoke', budget: 100, groups: [group('gui', [testCase()])] });

    expect(DEFAULT_CASE_DURATION).toBe(5);
    expect(plan.minutes).toBe(DEFAULT_CASE_DURATION);
    expect(plan.picked[0]?.duration).toBe(DEFAULT_CASE_DURATION);
    expect(plan.picked[0]?.reason).toContain('длительность не указана — считаем 5 мин');
  });

  it('бюджета не задали — берётся документированные полчаса', () => {
    expect(preview({ recipe: 'smoke', groups }).budget).toBe(30);
    expect(preview({ recipe: 'smoke', groups }).title).toBe('Дым за 30 мин');
  });

  it('архивный кейс в план не попадает', () => {
    const plan = preview({
      recipe: 'smoke',
      groups: [group('gui', [testCase({ archived: true }), testCase({ id: 'gui-002' })])],
    });

    expect(plan.picked.map((pick) => pick.caseId)).toEqual(['gui-002']);
  });
});

describe('project-tests/plan-recipes: регрессия по диффу', () => {
  const groups = [
    group('gui', [
      testCase({ id: 'gui-001', title: 'Отправка', area: 'chat', codePaths: ['src/pages/Chat'] }),
      testCase({ id: 'gui-002', title: 'Вложение', area: 'chat' }),
      testCase({ id: 'gui-003', title: 'Отчёт', area: 'analytics' }),
    ]),
  ];

  const impact: ProjectTestImpact = {
    files: ['src/pages/Chat/ChatPage.tsx'],
    cases: [
      {
        groupId: 'gui',
        caseId: 'gui-001',
        title: 'Отправка',
        reason: 'изменён src/pages/Chat',
      },
    ],
  };

  it('берёт задетые кейсы и соседей по зоне, чужую зону не трогает', () => {
    const plan = preview({ recipe: 'diff', groups, impact });

    expect(plan.picked.map((pick) => pick.caseId)).toEqual(['gui-001', 'gui-002']);
    expect(plan.picked[0]?.reason).toContain('изменён src/pages/Chat');
    expect(plan.picked[1]?.reason).toBe(
      'сосед по зоне «chat»; длительность не указана — считаем 5 мин',
    );
  });

  it('диффа нет — пустой план, а не вся библиотека', () => {
    const plan = preview({ recipe: 'diff', groups, impact: { files: [], cases: [] } });

    expect(plan.picked).toEqual([]);
    expect(plan.minutes).toBe(0);
  });
});

describe('project-tests/plan-recipes: план вехи', () => {
  const groups = [
    group('gui', [
      testCase({ id: 'gui-001', title: 'Требование вехи' }),
      testCase({ id: 'gui-002', title: 'Упал в этой вехе' }),
      testCase({ id: 'gui-003', title: 'Упал в прогоне без метки' }),
      testCase({ id: 'gui-004', title: 'Упал ещё до прошлой вехи' }),
    ]),
  ];

  const coverage: ProjectTestCoverage = {
    items: [
      {
        key: 'QA-1',
        url: 'https://acme.atlassian.net/browse/QA-1',
        cases: [{ groupId: 'gui', caseId: 'gui-001', title: 'Требование вехи', status: 'unknown' }],
        counts: { passed: 0, failed: 0, blocked: 0, skipped: 0, unknown: 1 },
      },
    ],
    orphans: [],
    source: 'jira',
  };

  it('кейсы требований вехи плюс красное с прошлой вехи, но не раньше её', () => {
    const plan = preview({
      recipe: 'release',
      release: 'v2',
      groups,
      coverage,
      runs: [
        runRecord('r3', [result('gui-002', 'failed')], 'v2'),
        runRecord('r2', [result('gui-003', 'blocked')]),
        runRecord('r1', [result('gui-004', 'failed')], 'v1'),
      ],
    });

    expect(plan.title).toBe('План вехи v2');
    expect(plan.picked.map((pick) => pick.caseId)).toEqual(['gui-001', 'gui-002', 'gui-003']);
    expect(plan.picked[0]?.reason).toContain('требование QA-1');
    expect(plan.picked[1]?.reason).toContain('красный с прошлой вехи');
  });
});

describe('project-tests/plan-recipes: нестабильные', () => {
  const groups = [
    group('gui', [
      testCase({ id: 'gui-001', title: 'Прыгает через раз' }),
      testCase({ id: 'gui-002', title: 'Дрогнул однажды' }),
      testCase({ id: 'gui-003', title: 'Ни разу не менялся' }),
    ]),
  ];

  const runs = runsOf([
    { caseId: 'gui-001', statuses: ['passed', 'failed', 'passed', 'failed'] },
    {
      caseId: 'gui-002',
      statuses: ['passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'failed'],
    },
    { caseId: 'gui-003', statuses: ['passed', 'passed', 'passed'] },
  ]);

  it('ниже порога — в план, выше — в «не влезло» с той же цифрой', () => {
    const plan = preview({ recipe: 'flaky', groups, runs });

    expect(plan.title).toBe('Нестабильные: стабильность ниже 80%');
    expect(plan.picked.map((pick) => pick.caseId)).toEqual(['gui-001']);
    expect(plan.picked[0]?.reason).toContain('стабильность 0% на 4 прогонах, порог 80%');
    // Стабильный кейс в «не влезло» не попадает: он там ничего не объясняет.
    expect(plan.left.map((pick) => pick.caseId)).toEqual(['gui-002']);
    expect(plan.left[0]?.reason).toBe('стабильность 83% — не ниже порога 80%');
  });

  it('порог задан долей 0–1 и меняет отбор', () => {
    const plan = preview({ recipe: 'flaky', groups, runs, threshold: 0.5 });

    expect(plan.title).toBe('Нестабильные: стабильность ниже 50%');
    expect(plan.picked.map((pick) => pick.caseId)).toEqual(['gui-001']);
    expect(plan.left.map((pick) => pick.caseId)).toEqual(['gui-002']);
  });
});

describe('project-tests/plan-recipes: сохранение', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-plan-recipes-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('предпросмотр превращается в обычный план и сохраняется как любой другой', () => {
    const groups = [
      group('gui', [
        testCase({ id: 'gui-001', title: 'Вход', priority: 'blocker', duration: 10 }),
        testCase({ id: 'gui-002', title: 'Отправка', priority: 'high', duration: 10 }),
      ]),
    ];
    const plan = toPlan(preview({ recipe: 'smoke', budget: 30, groups }), {
      environmentId: 'chrome',
    });

    expect(plan.id).toBe('');
    expect(plan.caseIds).toEqual(['gui:gui-001', 'gui:gui-002']);
    expect(plan.description).toContain('Кейсов: 2, минут: 20');
    expect(plan.environmentIds).toEqual(['chrome']);

    const saved = savePlan(root, plan, '2026-09-08T10:00:00.000Z');

    expect(readPlans(root).map((item) => item.id)).toEqual([saved.id]);
    // Кейсы записаны как «группа:кейс» — иначе одинаковые номера в разных
    // группах развернулись бы в чужие кейсы.
    expect(planCases(groups, saved).map((item) => item.testCase.id)).toEqual([
      'gui-001',
      'gui-002',
    ]);
  });

  it('неизвестное правило — ошибка, а не молча пустой план', () => {
    expect(() =>
      buildPlanPreview({ recipe: 'нет такого' as ProjectTestPlanRecipe, groups: [] }),
    ).toThrow('Неизвестное правило');
  });
});

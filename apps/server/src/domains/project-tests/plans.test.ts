import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestGroup } from '@agentdeck/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPoints, planCases, readPlan, readPlans, removePlan, savePlan } from './plans.ts';
import { readEnvironments, saveEnvironment } from './library.ts';
import { createGroup, upsertCase, readGroups } from './store.ts';

/**
 * Планы и тест-поинты.
 *
 * Главное здесь — что план НЕ копирует кейсы: он держит список или фильтр и
 * разворачивается по текущей библиотеке. И что кейс × окружение × комбинация
 * параметров даёт отдельные проходы: один кейс на двух браузерах должен давать
 * два результата, а не затирать сам себя.
 */
describe('project-tests/plans', () => {
  let project = '';
  const now = '2026-09-07T10:00:00.000Z';

  const groups = (): ProjectTestGroup[] => readGroups(project);

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-plans-'));
    createGroup(project, 'gui', 'GUI');
    upsertCase(
      project,
      'gui',
      { title: 'Отправка сообщения', steps: ['нажать'], tags: ['smoke'], priority: 'high' },
      now,
    );
    upsertCase(
      project,
      'gui',
      { title: 'Загрузка файла', steps: ['выбрать файл'], tags: ['regress'] },
      now,
    );
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('план сохраняется, читается и удаляется', () => {
    const plan = savePlan(project, { title: 'Релиз 1.0', caseIds: ['gui-001'] }, now);

    expect(readPlans(project)).toHaveLength(1);
    expect(readPlan(project, plan.id)?.title).toBe('Релиз 1.0');

    removePlan(project, plan.id);
    expect(readPlans(project)).toEqual([]);
  });

  it('динамический план берёт кейсы фильтром в момент прогона, а не копирует их', () => {
    const plan = savePlan(project, { title: 'Дым', filter: { tags: ['smoke'] } }, now);

    expect(planCases(groups(), plan).map((item) => item.testCase.title)).toEqual([
      'Отправка сообщения',
    ]);

    // Кейс переехал в другую метку — набор плана меняется сам собой.
    upsertCase(
      project,
      'gui',
      { id: 'gui-002', title: 'Загрузка файла', steps: [], tags: ['smoke'] },
      now,
    );
    expect(planCases(groups(), plan)).toHaveLength(2);
  });

  it('статический и динамический наборы складываются без дублей', () => {
    const plan = savePlan(
      project,
      { title: 'Смешанный', caseIds: ['gui-001'], filter: { tags: ['smoke'] } },
      now,
    );

    expect(planCases(groups(), plan)).toHaveLength(1);
  });

  it('кейс × окружение = отдельные проходы', () => {
    const first = saveEnvironment(project, { title: 'Chrome' });
    const second = saveEnvironment(project, { title: 'Firefox' });
    const plan = savePlan(
      project,
      { title: 'Кросс', caseIds: ['gui-001'], environmentIds: [first.id, second.id] },
      now,
    );

    const points = buildPoints(planCases(groups(), plan), readEnvironments(project), { plan });

    expect(points).toHaveLength(2);
    expect(new Set(points.map((point) => point.id)).size).toBe(2);
  });

  it('параметры кейса разворачиваются в комбинации, кейс без параметров — в один проход', () => {
    upsertCase(
      project,
      'gui',
      {
        id: 'gui-001',
        title: 'Отправка сообщения',
        steps: ['войти как {роль}'],
        parameters: [
          { name: 'роль', values: ['админ', 'гость'] },
          { name: 'язык', values: ['ru', 'en'] },
        ],
      },
      now,
    );

    const withParams = buildPoints(
      planCases(groups(), savePlan(project, { title: 'П', caseIds: ['gui-001'] }, now)),
      [],
    );
    const withoutParams = buildPoints(
      planCases(groups(), savePlan(project, { title: 'Б', caseIds: ['gui-002'] }, now)),
      [],
    );

    expect(withParams.length).toBeGreaterThan(1);
    expect(withoutParams).toHaveLength(1);
    expect(withoutParams[0]?.params).toBeUndefined();
  });

  it('план без названия не сохраняется', () => {
    expect(() => savePlan(project, { title: '   ' }, now)).toThrow();
  });
});

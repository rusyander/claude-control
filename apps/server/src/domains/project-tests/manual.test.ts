import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectTestManualRegistry, remainingPoints } from './manual.ts';
import { createGroup, readGroups, upsertCase } from './store.ts';
import { readRuns } from './runs-store.ts';
import { savePlan } from './plans.ts';
import { ProjectTestsError, ProjectTestsNotFoundError } from './files.ts';

/**
 * Ручной прогон: кейсы проходит человек, панель записывает.
 *
 * Главное свойство — результат уходит на диск СРАЗУ, а не в конце: закрытая
 * вкладка, выключенная панель или переход на телефон не должны стоить
 * отмеченного. Поэтому проверяется не только состояние сессии в памяти, но и
 * файл кейса, и запись прогона.
 */
describe('project-tests/manual', () => {
  let project = '';
  let manual: ProjectTestManualRegistry;
  const now = '2026-09-07T10:00:00.000Z';

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-manual-'));
    manual = new ProjectTestManualRegistry();
    createGroup(project, 'gui', 'GUI');
    upsertCase(project, 'gui', { title: 'Вход', steps: ['открыть'] }, now);
    upsertCase(project, 'gui', { title: 'Выход', steps: ['нажать'] }, now);
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('прогон по группе разворачивается в проходы по числу кейсов', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);

    expect(session.points).toHaveLength(2);
    expect(session.index).toBe(0);
    expect(remainingPoints(session)).toHaveLength(2);
  });

  it('отмеченный результат сразу лежит в файле кейса и в истории', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);
    const point = session.points[0]!;

    manual.record(
      project,
      { runId: session.runId, pointId: point.id, status: 'failed', note: 'кнопка не нажимается' },
      '2026-09-07T10:05:00.000Z',
    );

    const testCase = readGroups(project)[0]?.cases.find((item) => item.id === point.caseId);
    expect(testCase?.status).toBe('failed');
    expect(testCase?.note).toBe('кнопка не нажимается');
    expect(testCase?.lastRunAt).toBe('2026-09-07T10:05:00.000Z');

    const [run] = readRuns(project);
    expect(run?.actor).toBe('human');
    expect(run?.results).toHaveLength(1);
    expect(run?.summary.failed).toBe(1);
  });

  it('курсор переезжает на первый неотмеченный проход', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);

    const after = manual.record(
      project,
      { runId: session.runId, pointId: session.points[0]!.id, status: 'passed' },
      now,
    );

    expect(after.index).toBe(1);
    expect(remainingPoints(after)).toHaveLength(1);
  });

  it('повторная отметка того же прохода заменяет результат, а не добавляет второй', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);
    const point = session.points[0]!;

    manual.record(project, { runId: session.runId, pointId: point.id, status: 'failed' }, now);
    const after = manual.record(
      project,
      { runId: session.runId, pointId: point.id, status: 'passed' },
      '2026-09-07T10:10:00.000Z',
    );

    expect(after.results).toHaveLength(1);
    expect(after.results[0]?.status).toBe('passed');
  });

  it('второй прогон по тому же проекту не начинается — иначе два человека пишут в один файл', () => {
    manual.start(project, { groupId: 'gui' }, now);

    expect(() => manual.start(project, { groupId: 'gui' }, now)).toThrow(ProjectTestsError);
  });

  it('завершённый прогон отпускает проект', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);
    manual.finish(project, session.runId, '2026-09-07T11:00:00.000Z');

    expect(manual.get(project)?.finishedAt).toBe('2026-09-07T11:00:00.000Z');
    expect(() => manual.start(project, { groupId: 'gui' }, now)).not.toThrow();
  });

  it('брошенный прогон оставляет отмеченное, но убирает сессию', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);
    manual.record(
      project,
      { runId: session.runId, pointId: session.points[0]!.id, status: 'passed' },
      now,
    );
    manual.cancel(project, session.runId, '2026-09-07T11:00:00.000Z');

    expect(manual.get(project)).toBeUndefined();
    expect(readGroups(project)[0]?.cases[0]?.status).toBe('passed');
    expect(readRuns(project)[0]?.status).toBe('stopped');
  });

  /** Сводку убирают той же кнопкой — но история уже закрыта и переписывать её нельзя. */
  it('закрытие сводки не превращает завершённый прогон в брошенный', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);
    manual.finish(project, session.runId, '2026-09-07T11:00:00.000Z');
    manual.cancel(project, session.runId, '2026-09-07T11:30:00.000Z');

    expect(manual.get(project)).toBeUndefined();
    expect(readRuns(project)[0]?.status).toBe('done');
    expect(readRuns(project)[0]?.finishedAt).toBe('2026-09-07T11:00:00.000Z');
  });

  it('прогон по несуществующему плану — 404, а не пустая сессия', () => {
    expect(() => manual.start(project, { planId: 'missing-plan' }, now)).toThrow(
      ProjectTestsNotFoundError,
    );
  });

  it('прогон по плану берёт его кейсы', () => {
    const plan = savePlan(project, { title: 'Дым', caseIds: ['gui-002'] }, now);

    const session = manual.start(project, { planId: plan.id }, now);

    expect(session.points.map((point) => point.caseId)).toEqual(['gui-002']);
    expect(session.planId).toBe(plan.id);
  });

  it('чужой проход не отмечается', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);

    expect(() =>
      manual.record(project, { runId: session.runId, pointId: 'чужой', status: 'passed' }, now),
    ).toThrow(ProjectTestsNotFoundError);
  });
});

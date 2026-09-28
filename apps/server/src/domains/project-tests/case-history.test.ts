import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestPointResult, ProjectTestRunRecord } from '@agentdeck/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { caseHistory, flakyMarks, flakyVerdict, readCaseHistory } from './case-history.ts';
import { writeRun } from './runs-store.ts';

/**
 * История результатов кейса и отметка «нестабилен».
 *
 * Главное: точка истории — прогон, а не проход (кейс с параметрами не должен
 * «мигать» внутри одного прогона), порядок от новых к старым, и правило
 * нестабильности, которое не путает одну поломку с мигающим тестом.
 */
const run = (
  id: string,
  startedAt: string,
  results: Partial<ProjectTestPointResult>[],
  extra: Partial<ProjectTestRunRecord> = {},
): ProjectTestRunRecord => ({
  id,
  mode: 'run',
  actor: 'agent',
  status: 'done',
  startedAt,
  results: results.map((item) => ({
    pointId: `gui:${item.caseId ?? 'a'}`,
    groupId: 'gui',
    caseId: 'a',
    status: 'passed',
    ...item,
  })) as ProjectTestPointResult[],
  summary: { total: results.length, passed: 0, failed: 0, skipped: 0, blocked: 0 },
  ...extra,
});

/** Прогоны от новых к старым — так их отдаёт хранилище. */
const newestFirst = (statuses: string[]): ProjectTestRunRecord[] =>
  statuses
    .map((status, index) =>
      run(`r${index}`, `2026-09-${String(10 + index).padStart(2, '0')}T10:00:00.000Z`, [
        { status: status as ProjectTestPointResult['status'] },
      ]),
    )
    .reverse();

describe('project-tests/case-history', () => {
  it('история кейса — от новых к старым, одна точка на прогон, худший проход решает', () => {
    const runs = [
      run('new', '2026-09-20T10:00:00.000Z', [
        { status: 'passed', params: { theme: 'dark' } },
        {
          status: 'failed',
          params: { theme: 'light' },
          note: 'Кнопка не видна',
          failure: { step: 2, expected: 'видна', actual: 'нет' },
          defects: ['https://tracker.example.com/PROJ-1'],
        },
      ]),
      run('other', '2026-09-15T10:00:00.000Z', [{ caseId: 'b', status: 'failed' }]),
      run('old', '2026-09-10T10:00:00.000Z', [{ status: 'passed' }], { release: 'v1.4' }),
    ];

    const history = caseHistory(runs, 'gui', 'a');

    expect(history.entries.map((entry) => entry.runId)).toEqual(['new', 'old']);
    expect(history.entries[0]).toMatchObject({
      status: 'failed',
      points: 2,
      note: 'Кнопка не видна',
      failure: { step: 2 },
      defects: ['https://tracker.example.com/PROJ-1'],
    });
    expect(history.entries[1]).toMatchObject({ status: 'passed', points: 1, release: 'v1.4' });
  });

  it('кейс, которого не гоняли, — пустая история, не ошибка', () => {
    const history = caseHistory(newestFirst(['passed']), 'gui', 'nope');
    expect(history.entries).toEqual([]);
    expect(history.flaky).toEqual({ isFlaky: false, flips: 0, runs: 0 });
  });

  it('одна смена исхода — поломка, а не нестабильность', () => {
    expect(flakyVerdict(['passed', 'passed', 'failed', 'failed']).isFlaky).toBe(false);
    expect(flakyVerdict(['failed', 'passed']).isFlaky).toBe(false);
  });

  it('две смены — нестабилен; пропуски и блокировки не считаются', () => {
    const verdict = flakyVerdict(['passed', 'skipped', 'failed', 'blocked', 'passed']);
    expect(verdict).toEqual({ isFlaky: true, flips: 2, runs: 3 });
  });

  it('окно — последние прогоны: старая чехарда не метит починенный кейс', () => {
    // От старых к новым: мигал давно, потом 10 зелёных подряд.
    const statuses = ['passed', 'failed', 'passed', 'failed', ...Array(10).fill('passed')];
    expect(flakyVerdict(statuses).isFlaky).toBe(false);
  });

  it('отметки библиотеки — только нестабильные кейсы, по окну последних прогонов', () => {
    const runs = [
      run('r3', '2026-09-13T10:00:00.000Z', [
        { caseId: 'a', status: 'passed' },
        { caseId: 'b', status: 'failed' },
      ]),
      run('r2', '2026-09-12T10:00:00.000Z', [
        { caseId: 'a', status: 'failed' },
        { caseId: 'b', status: 'failed' },
      ]),
      run('r1', '2026-09-11T10:00:00.000Z', [
        { caseId: 'a', status: 'passed' },
        { caseId: 'b', status: 'passed' },
      ]),
    ];
    const marks = flakyMarks(runs);
    expect(marks.cases).toEqual([
      { groupId: 'gui', caseId: 'a', isFlaky: true, flips: 2, runs: 3 },
    ]);
    expect(marks.window).toBeGreaterThan(0);
    expect(marks.minFlips).toBe(2);
  });

  it('вердикт истории читает окно с НОВОГО конца: давняя чехарда не метит кейс', () => {
    // От старых к новым: мигал три прогона, потом 10 зелёных. Хранилище отдаёт
    // прогоны от новых к старым — если их не развернуть, окно схватит старое.
    const runs = newestFirst(['failed', 'passed', 'failed', ...Array(10).fill('passed')]);
    expect(caseHistory(runs, 'gui', 'a').flaky).toEqual({ isFlaky: false, flips: 0, runs: 10 });
  });

  it('отметки: кейс с параметрами — один исход на прогон, окно не съедается проходами', () => {
    const runs = [
      run('r2', '2026-09-12T10:00:00.000Z', [
        { status: 'failed', params: { theme: 'dark' } },
        { status: 'passed', params: { theme: 'light' } },
      ]),
      run('r1', '2026-09-11T10:00:00.000Z', [
        { status: 'passed', params: { theme: 'dark' } },
        { status: 'passed', params: { theme: 'light' } },
      ]),
    ];
    // Одна смена (зелёный → красный) на два прогона — не нестабилен, и прогонов два, а не четыре.
    expect(flakyMarks(runs).cases).toEqual([]);
    const withFlip = [
      run('r3', '2026-09-13T10:00:00.000Z', [
        { status: 'passed', params: { theme: 'dark' } },
        { status: 'passed', params: { theme: 'light' } },
      ]),
      ...runs,
    ];
    expect(flakyMarks(withFlip).cases).toEqual([
      { groupId: 'gui', caseId: 'a', isFlaky: true, flips: 2, runs: 3 },
    ]);
  });

  it('карточка и библиотека одинаково решают прогон «пройден + пропущен»', () => {
    // Кейс с двумя значениями: в зелёных прогонах одно пройдено, другое пропущено.
    const pair = (id: string, day: number, statuses: string[]): ProjectTestRunRecord =>
      run(
        id,
        `2026-09-${String(10 + day).padStart(2, '0')}T10:00:00.000Z`,
        statuses.map((status, index) => ({
          status: status as ProjectTestPointResult['status'],
          params: { v: String(index) },
        })),
      );
    const runs = [
      pair('r6', 6, ['passed', 'skipped']),
      pair('r5', 5, ['failed']),
      pair('r4', 4, ['passed', 'skipped']),
      pair('r3', 3, ['failed']),
      pair('r2', 2, ['passed', 'skipped']),
      pair('r1', 1, ['failed']),
    ];
    const card = caseHistory(runs, 'gui', 'a');
    const [mark] = flakyMarks(runs).cases;
    expect(card.entries.map((entry) => entry.status)).toEqual([
      'passed',
      'failed',
      'passed',
      'failed',
      'passed',
      'failed',
    ]);
    expect(card.flaky).toEqual({ isFlaky: mark?.isFlaky, flips: mark?.flips, runs: mark?.runs });
    expect(card.flaky).toEqual({ isFlaky: true, flips: 5, runs: 6 });
  });

  describe('с диска', () => {
    let project = '';
    beforeEach(() => {
      project = mkdtempSync(join(tmpdir(), 'cc-tests-case-history-'));
    });
    afterEach(() => {
      rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    it('читает записи прогонов проекта', () => {
      writeRun(project, run('aaaaaaaa', '2026-09-01T10:00:00.000Z', [{ status: 'failed' }]));
      writeRun(project, run('bbbbbbbb', '2026-09-02T10:00:00.000Z', [{ status: 'passed' }]));
      const history = readCaseHistory(project, 'gui', 'a');
      expect(history.entries.map((entry) => [entry.runId, entry.status])).toEqual([
        ['bbbbbbbb', 'passed'],
        ['aaaaaaaa', 'failed'],
      ]);
    });
  });
});

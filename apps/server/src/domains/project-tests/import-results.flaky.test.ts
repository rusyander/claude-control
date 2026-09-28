import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importResults } from './import-results.ts';
import { readGroups } from './store.ts';
import { readRun, readRuns } from './runs-store.ts';
import { reasonOf } from './point-reason.ts';

/**
 * F-355: «Нестабильный: прошёл только на повторе (упавших попыток: N).» лежал
 * ДАННЫМИ — заметкой кейса и прохода, по-русски, и английский интерфейс
 * показывал его как есть. Теперь это поле: у прохода `flakyAttempts`, у кейса
 * `flaky {attempts, runId}` (привязан к прогону, который его дал), а слова
 * берёт каждая сторона из своего словаря. Старые записи с русской заметкой
 * читаются тем же полем.
 */
const JUNIT =
  '<testsuites><testsuite name="a.spec.ts">' +
  '<testcase name="[gui-001] открывает чат" classname="a.spec.ts" time="1">' +
  '<flakyFailure message="m1" type="FAILURE"/><flakyFailure message="m2" type="FAILURE"/>' +
  '</testcase></testsuite></testsuites>';

describe('нестабильный на повторе — поле, а не русская заметка', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-flaky-'));
    mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const writeGroup = (cases: unknown[]) =>
    writeFileSync(
      join(root, '.agent', 'tests', 'gui.tests.json'),
      JSON.stringify({ version: 1, title: 'GUI', cases }, null, 2),
    );

  it('импорт кладёт число попыток в проход и кейс, заметку не пишет', () => {
    writeGroup([{ id: 'gui-001', title: 'Открытие чата', steps: [], status: 'unknown' }]);
    const result = importResults(root, { format: 'junit', content: JUNIT });
    expect(result.matched).toBe(1);

    const run = readRun(root, result.runId!);
    expect(run?.results[0]).toMatchObject({ status: 'passed', flakyAttempts: 2 });
    expect(run?.results[0]?.note).toBeUndefined();

    const testCase = readGroups(root)[0]?.cases[0];
    expect(testCase).toMatchObject({
      status: 'passed',
      flaky: { attempts: 2, runId: result.runId },
    });
    expect(testCase?.note).toBeUndefined();

    // Выгрузка называет его словами своего языка.
    expect(reasonOf(run!.results[0]!, 'en')).toBe('passed only on a retry (failed attempts: 2)');
    expect(reasonOf(run!.results[0]!, 'ru')).toBe('прошёл только на повторе (упавших попыток: 2)');
  });

  it('старые записи: русская заметка читается полем, чужая заметка остаётся', () => {
    writeGroup([
      {
        id: 'gui-001',
        title: 'a',
        steps: [],
        status: 'passed',
        lastRunId: 'r-old',
        note: 'Нестабильный: прошёл только на повторе (упавших попыток: 3).',
      },
      {
        id: 'gui-002',
        title: 'b',
        steps: [],
        status: 'passed',
        lastRunId: 'r-old',
        note: 'Нестабильный: прошёл только на повторе.',
      },
      { id: 'gui-003', title: 'c', steps: [], status: 'passed', note: 'Нестабильный стенд' },
    ]);
    const cases = readGroups(root)[0]?.cases ?? [];
    expect(cases[0]).toMatchObject({ flaky: { attempts: 3, runId: 'r-old' } });
    expect(cases[0]?.note).toBeUndefined();
    expect(cases[1]).toMatchObject({ flaky: { attempts: 1, runId: 'r-old' } });
    expect(cases[1]?.note).toBeUndefined();
    expect(cases[2]).toMatchObject({ note: 'Нестабильный стенд' });
    expect(cases[2]?.flaky).toBeUndefined();

    mkdirSync(join(root, '.agent', 'tests', 'runs'), { recursive: true });
    writeFileSync(
      join(root, '.agent', 'tests', 'runs', 'r-old.run.json'),
      JSON.stringify({
        id: 'r-old',
        mode: 'import',
        startedAt: '2026-09-01T00:00:00.000Z',
        results: [
          {
            pointId: 'gui:gui-001',
            groupId: 'gui',
            caseId: 'gui-001',
            status: 'passed',
            flakyAttempts: 3,
            note: 'Нестабильный: прошёл только на повторе (упавших попыток: 3).',
          },
          {
            pointId: 'gui:gui-002',
            groupId: 'gui',
            caseId: 'gui-002',
            status: 'passed',
            note: 'Нестабильный: прошёл только на повторе.',
          },
        ],
      }),
    );
    const [run] = readRuns(root);
    expect(run?.results.map((item) => [item.flakyAttempts, item.note])).toEqual([
      [3, undefined],
      [1, undefined],
    ]);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ProjectTestPointResult,
  ProjectTestRunRecord,
  ProjectTestStatus,
} from '@agentdeck/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffRuns, diffWithPrevious, failedCases } from './compare.ts';
import { writeRun } from './runs-store.ts';

/**
 * Сравнение прогонов.
 *
 * Проверяется главное свойство: списки не пересекаются, и кейс попадает ровно в
 * один. По этим спискам жмут кнопки («перепрогнать провалившиеся»), и кейс,
 * оказавшийся в двух сразу, был бы запущен дважды.
 *
 * Второе — честность сравнения. Прогон по другому плану или в другом окружении
 * это другой набор, и «починилось» там часто значит «в этот раз не гоняли».
 */

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

const record = (
  id: string,
  startedAt: string,
  results: ProjectTestPointResult[],
  over: Partial<ProjectTestRunRecord> = {},
): ProjectTestRunRecord => ({
  id,
  mode: 'run',
  actor: 'agent',
  status: 'done',
  startedAt,
  finishedAt: startedAt,
  results,
  summary: {
    total: results.length,
    passed: results.filter((item) => item.status === 'passed').length,
    failed: results.filter((item) => item.status === 'failed').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    blocked: results.filter((item) => item.status === 'blocked').length,
  },
  ...over,
});

describe('project-tests/compare: пары прогонов', () => {
  it('раскладывает кейсы по пяти спискам, и списки не пересекаются', () => {
    const before = record('r1', '2026-09-01T10:00:00.000Z', [
      result('gui-001', 'passed'),
      result('gui-002', 'failed'),
      result('gui-003', 'failed'),
      result('gui-004', 'passed'),
    ]);
    const after = record('r2', '2026-09-02T10:00:00.000Z', [
      result('gui-001', 'failed', { note: 'кнопка не нажимается' }),
      result('gui-002', 'passed'),
      result('gui-003', 'failed'),
      result('gui-004', 'passed'),
      result('gui-005', 'passed'),
    ]);

    const diff = diffRuns(before, after);

    expect(diff.newFailures.map((item) => item.caseId)).toEqual(['gui-001']);
    expect(diff.newFailures[0]).toMatchObject({ from: 'passed', to: 'failed' });
    expect(diff.newFailures[0]?.note).toBe('кнопка не нажимается');
    expect(diff.fixed.map((item) => item.caseId)).toEqual(['gui-002']);
    expect(diff.stillFailing.map((item) => item.caseId)).toEqual(['gui-003']);
    expect(diff.untouched.map((item) => item.caseId)).toEqual(['gui-004']);
    expect(diff.added.map((item) => item.caseId)).toEqual(['gui-005']);
    expect(diff.removed).toEqual([]);

    const all = [
      ...diff.newFailures,
      ...diff.fixed,
      ...diff.stillFailing,
      ...diff.untouched,
      ...diff.added,
    ].map((item) => item.caseId);
    expect(new Set(all).size).toBe(all.length);
  });

  it('кейс, которого в новом прогоне нет, назван пропавшим, а не починенным', () => {
    const diff = diffRuns(
      record('r1', '2026-09-01T10:00:00.000Z', [result('gui-001', 'failed')]),
      record('r2', '2026-09-02T10:00:00.000Z', [result('gui-002', 'passed')]),
    );

    expect(diff.removed.map((item) => item.caseId)).toEqual(['gui-001']);
    expect(diff.fixed).toEqual([]);
    expect(diff.added.map((item) => item.caseId)).toEqual(['gui-002']);
  });

  it('новый кейс, сразу красный, — это новый провал, а не просто «появился»', () => {
    const diff = diffRuns(
      record('r1', '2026-09-01T10:00:00.000Z', [result('gui-001', 'passed')]),
      record('r2', '2026-09-02T10:00:00.000Z', [
        result('gui-001', 'passed'),
        result('gui-009', 'failed'),
      ]),
    );

    expect(diff.newFailures.map((item) => item.caseId)).toEqual(['gui-009']);
    expect(diff.newFailures[0]?.from).toBeUndefined();
    expect(diff.added).toEqual([]);
  });

  it('блокировка считается красным: результата у кейса нет и в этот раз', () => {
    const diff = diffRuns(
      record('r1', '2026-09-01T10:00:00.000Z', [result('gui-001', 'passed')]),
      record('r2', '2026-09-02T10:00:00.000Z', [result('gui-001', 'blocked')]),
    );

    expect(diff.newFailures.map((item) => item.caseId)).toEqual(['gui-001']);
  });

  it('пропуск победой не считается: из красного в skipped — не «починено»', () => {
    const diff = diffRuns(
      record('r1', '2026-09-01T10:00:00.000Z', [result('gui-001', 'failed')]),
      record('r2', '2026-09-02T10:00:00.000Z', [result('gui-001', 'skipped')]),
    );

    expect(diff.fixed).toEqual([]);
    expect(diff.untouched.map((item) => item.caseId)).toEqual(['gui-001']);
  });

  it('из нескольких точек кейса берётся худшая — одна красная красит кейс', () => {
    const diff = diffRuns(
      record('r1', '2026-09-01T10:00:00.000Z', [result('gui-001', 'passed')]),
      record('r2', '2026-09-02T10:00:00.000Z', [
        { ...result('gui-001', 'passed'), pointId: 'gui:gui-001:ru' },
        { ...result('gui-001', 'failed'), pointId: 'gui:gui-001:en' },
      ]),
    );

    expect(diff.newFailures.map((item) => item.caseId)).toEqual(['gui-001']);
    expect(diff.untouched).toEqual([]);
  });

  it('разные план и окружение — сравнение честно называет наборы разными', () => {
    const diff = diffRuns(
      record('r1', '2026-09-01T10:00:00.000Z', [result('gui-001', 'passed')], {
        planId: 'smoke',
        environmentId: 'local',
      }),
      record('r2', '2026-09-02T10:00:00.000Z', [result('gui-001', 'passed')], {
        planId: 'release',
        environmentId: 'stage',
      }),
    );

    expect(diff.comparable).toBe(false);
    expect(diff.warning).toContain('планам');
    expect(diff.warning).toContain('окружения');
  });

  it('название кейса подтягивается из библиотеки: в записи прогона его нет', () => {
    const diff = diffRuns(
      record('r1', '2026-09-01T10:00:00.000Z', [result('gui-001', 'passed')]),
      record('r2', '2026-09-02T10:00:00.000Z', [result('gui-001', 'failed')]),
      [
        {
          id: 'gui',
          title: 'GUI',
          file: 'f',
          cases: [
            {
              id: 'gui-001',
              type: 'case',
              title: 'Отправка сообщения',
              steps: [],
              status: 'failed',
              source: 'agent',
            },
          ],
        },
      ],
    );

    expect(diff.newFailures[0]?.title).toBe('Отправка сообщения');
  });

  it('перепрогонять надо провалы и блокировки, каждый по разу', () => {
    expect(
      failedCases(
        record('r1', '2026-09-01T10:00:00.000Z', [
          result('gui-001', 'failed'),
          { ...result('gui-001', 'failed'), pointId: 'gui:gui-001:en' },
          result('gui-002', 'blocked'),
          result('gui-003', 'passed'),
        ]),
      ),
    ).toEqual(['gui-001', 'gui-002']);
  });
});

describe('project-tests/compare: предыдущий прогон', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-compare-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('предыдущий — ближайший СТАРШЕ, а не предыдущая строка истории', () => {
    writeRun(root, record('r1', '2026-09-01T10:00:00.000Z', [result('gui-001', 'failed')]));
    // Генерация лежит в той же истории, но результатов у неё нет: сравнивать с
    // ней нечего, и она обязана быть пропущена.
    writeRun(root, record('r2', '2026-09-02T10:00:00.000Z', [], { mode: 'generate' }));
    writeRun(root, record('r3', '2026-09-03T10:00:00.000Z', [result('gui-001', 'passed')]));

    const diff = diffWithPrevious(root, 'r3');

    expect(diff.from.id).toBe('r1');
    expect(diff.fixed.map((item) => item.caseId)).toEqual(['gui-001']);
  });

  it('первый прогон сравнивать не с чем, и это сказано словами', () => {
    writeRun(root, record('r1', '2026-09-01T10:00:00.000Z', [result('gui-001', 'passed')]));

    expect(() => diffWithPrevious(root, 'r1')).toThrow(/первый прогон/);
  });

  it('названный вручную прогон сравнения берётся как есть', () => {
    writeRun(root, record('r1', '2026-09-01T10:00:00.000Z', [result('gui-001', 'failed')]));
    writeRun(root, record('r2', '2026-09-02T10:00:00.000Z', [result('gui-001', 'failed')]));
    writeRun(root, record('r3', '2026-09-03T10:00:00.000Z', [result('gui-001', 'passed')]));

    expect(diffWithPrevious(root, 'r3', 'r1').from.id).toBe('r1');
  });

  it('несуществующий прогон — отказ с его именем, а не пустое сравнение', () => {
    expect(() => diffWithPrevious(root, 'нет-такого')).toThrow(/нет-такого/);
  });
});

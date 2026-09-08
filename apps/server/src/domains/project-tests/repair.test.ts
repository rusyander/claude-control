import type { ProjectTestPointResult, ProjectTestRunRecord } from '@agentdeck/contracts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repairFutureStamps } from './repair.ts';
import { createGroup, readGroups, upsertCase } from './store.ts';

/**
 * Отметки «из будущего»: агент писал местное время с буквой Z, и на UTC+5 кейс
 * оказывался прогнанным через пять часов. Починка берёт время из записи прогона,
 * из результатов или из сдвига пояса — и снимает отметку, когда взять неоткуда.
 */
const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const FUTURE = '2026-09-08T17:00:00.000Z';
const OFFSET_MS = new Date(NOW).getTimezoneOffset() * 60_000;

const point = (caseId: string, finishedAt?: string): ProjectTestPointResult =>
  ({
    pointId: `api:${caseId}`,
    groupId: 'api',
    caseId,
    status: 'passed',
    finishedAt,
  }) as ProjectTestPointResult;

const record = (
  id: string,
  finishedAt: string,
  results: ProjectTestPointResult[] = [],
): ProjectTestRunRecord =>
  ({
    id,
    mode: 'run',
    actor: 'agent',
    groupId: 'api',
    status: 'done',
    startedAt: '2026-09-08T09:00:00.000Z',
    finishedAt,
    results,
  }) as unknown as ProjectTestRunRecord;

describe('project-tests/repair: отметки из будущего', () => {
  let root = '';

  const stamp = (id: string, patch: Record<string, unknown>) => {
    const file = join(root, '.agent', 'tests', 'api.tests.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.cases = data.cases.map((item: { id: string }) =>
      item.id === id ? { ...item, ...patch } : item,
    );
    writeFileSync(file, JSON.stringify(data, null, 2));
  };
  const caseOf = (id: string) =>
    readGroups(root)
      .find((g) => g.id === 'api')
      ?.cases.find((c) => c.id === id);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-tests-repair-'));
    createGroup(root, 'api');
    upsertCase(root, 'api', { title: 'A', steps: ['x'] }, '2026-09-08T09:00:00.000Z');
    upsertCase(root, 'api', { title: 'B', steps: ['y'] }, '2026-09-08T09:00:00.000Z');
    upsertCase(root, 'api', { title: 'C', steps: ['z'] }, '2026-09-08T09:00:00.000Z');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('ссылка на прогон — отметка берётся из его записи, статус остаётся', () => {
    stamp('api-001', { status: 'failed', lastRunAt: FUTURE, lastRunId: 'run-1' });

    const fixed = repairFutureStamps(root, [record('run-1', '2026-09-08T10:30:00.000Z')], NOW);

    expect(fixed).toEqual([
      {
        groupId: 'api',
        caseId: 'api-001',
        from: FUTURE,
        to: '2026-09-08T10:30:00.000Z',
        how: 'run',
      },
    ]);
    expect(caseOf('api-001')?.lastRunAt).toBe('2026-09-08T10:30:00.000Z');
    expect(caseOf('api-001')?.status).toBe('failed');
  });

  it('без ссылки — новейший прогон, где кейс есть в результатах', () => {
    stamp('api-002', { status: 'passed', lastRunAt: FUTURE });
    const runs = [
      record('run-3', '2026-09-08T11:00:00.000Z', [point('api-001')]),
      record('run-2', '2026-09-08T10:00:00.000Z', [point('api-002', '2026-09-08T09:59:00.000Z')]),
      record('run-1', '2026-09-08T08:00:00.000Z', [point('api-002')]),
    ];

    const fixed = repairFutureStamps(root, runs, NOW);

    expect(fixed[0]?.how).toBe('results');
    expect(caseOf('api-002')?.lastRunAt).toBe('2026-09-08T09:59:00.000Z');
  });

  // На машине западнее UTC местное время с буквой Z уходит в прошлое, а не в
  // будущее: чинить там нечего, и ветка сдвига недостижима.
  it.skipIf(OFFSET_MS >= 0)('без записей — местное время с Z возвращается сдвигом пояса', () => {
    const localAsUtc = new Date(NOW - OFFSET_MS).toISOString();
    stamp('api-003', { status: 'passed', lastRunAt: localAsUtc });

    const fixed = repairFutureStamps(root, [], NOW);

    expect(fixed[0]?.how).toBe('timezone');
    expect(caseOf('api-003')?.lastRunAt).toBe(new Date(NOW).toISOString());
  });

  it('когда взять неоткуда и сдвиг не спасает — отметка снимается, статус нет', () => {
    stamp('api-003', { status: 'blocked', lastRunAt: '2027-01-01T00:00:00.000Z' });

    const fixed = repairFutureStamps(root, [], NOW);

    expect(fixed[0]?.how).toBe('dropped');
    expect(caseOf('api-003')?.lastRunAt).toBeUndefined();
    expect(caseOf('api-003')?.status).toBe('blocked');
  });

  it('прошлое и минута вперёд не трогаются; повторный проход пуст', () => {
    stamp('api-001', { status: 'passed', lastRunAt: '2026-09-08T11:00:00.000Z' });
    stamp('api-002', { status: 'passed', lastRunAt: '2026-09-08T12:00:30.000Z' });
    stamp('api-003', { status: 'passed', lastRunAt: FUTURE, lastRunId: 'run-1' });

    const runs = [record('run-1', '2026-09-08T10:30:00.000Z')];
    expect(repairFutureStamps(root, runs, NOW)).toHaveLength(1);
    expect(caseOf('api-001')?.lastRunAt).toBe('2026-09-08T11:00:00.000Z');
    expect(caseOf('api-002')?.lastRunAt).toBe('2026-09-08T12:00:30.000Z');
    expect(repairFutureStamps(root, runs, NOW)).toEqual([]);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectTestPointResult, ProjectTestRunRecord } from '@agentdeck/contracts';
import { RECORDED_HISTORY_MAX } from '@agentdeck/contracts/project-tests-recorded';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeRun } from '../runs-store/runs-store.ts';
import { upsertCase } from '../store/store.ts';
import { recordedCases, recordedKeys } from './history.ts';
import { recordWalk } from './record.ts';
import { walkRows } from './__fixtures__/walk-rows.ts';

function runAt(index: number, caseId: string, status: ProjectTestPointResult['status']) {
  const startedAt = new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString();
  const record: ProjectTestRunRecord = {
    id: `run-${String(index).padStart(3, '0')}`,
    mode: 'import',
    actor: 'ci',
    status: 'done',
    startedAt,
    results: [{ pointId: `scenarios:${caseId}`, groupId: 'scenarios', caseId, status }],
    summary: { total: 1, passed: 0, failed: 0, skipped: 0, blocked: 0 },
  };
  return record;
}

describe('recorded history', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-recorded-history-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('shows the last 20 runs of a recorded case, newest first, and only recorded cases', () => {
    const { caseId } = recordWalk(
      root,
      {
        path: root,
        groupId: 'scenarios',
        title: 'Вход',
        taskId: 't',
        ...walkRows('http://127.0.0.1:1'),
      },
      '2026-11-01T00:00:00.000Z',
    );
    upsertCase(
      root,
      'scenarios',
      { title: 'Обычный кейс', steps: ['шаг'] },
      '2026-11-01T00:00:00.000Z',
    );
    for (let index = 0; index < 25; index += 1) {
      writeRun(root, runAt(index, caseId, index === 24 ? 'failed' : 'passed'));
    }
    expect(recordedKeys(root).map((key) => key.testCase.id)).toEqual([caseId]);
    const [view] = recordedCases(root);
    expect(RECORDED_HISTORY_MAX).toBe(20);
    expect(view!.history).toHaveLength(20);
    expect(view!.history[0]).toMatchObject({ runId: 'run-024', status: 'failed' });
    expect(view!.history[19]!.runId).toBe('run-005');
  });
});

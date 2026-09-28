import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRuns, writeRun } from '../../domains/project-tests/runs-store.ts';
import { settleOrphansOnce, type TestsDeps } from './shared.ts';

/**
 * «Раз на проект за жизнь процесса» считается только УДАВШИЙСЯ проход: один
 * сбой чтения не должен оставлять сироту «идёт» до следующего перезапуска.
 */
describe('settleOrphansOnce', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-orphans-once-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('сбой первого прохода не закрывает проект: следующий просмотр сироту закрывает', () => {
    writeRun(root, {
      id: 'orphan-1',
      mode: 'run',
      actor: 'agent',
      groupId: 'api',
      status: 'running',
      startedAt: '2026-09-08T09:00:00.000Z',
      results: [],
    } as unknown as ProjectTestRunRecord);

    let calls = 0;
    const deps = {
      runs: {
        get: () => {
          calls += 1;
          if (calls === 1) throw new Error('transient');
          return undefined;
        },
      },
    } as unknown as TestsDeps;

    settleOrphansOnce(root, deps);
    expect(readRuns(root)[0]?.status).toBe('running');

    settleOrphansOnce(root, deps);
    expect(readRuns(root)[0]?.status).toBe('error');
    expect(calls).toBe(2);

    // Удавшийся проход — последний: дальше проект не перечитывается.
    settleOrphansOnce(root, deps);
    expect(calls).toBe(2);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectTestPointResult, ProjectTestRunRecord } from '@agentdeck/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeRun } from '../runs-store/runs-store.ts';
import { recordWalk } from './record.ts';
import { RecordedReplayBusyError, RecordedReplays, type RunCli } from './replay.ts';
import type { RecordedWalkRequest } from './recorded.types.ts';
import { walkRows } from './__fixtures__/walk-rows.ts';

const ORIGIN = 'http://127.0.0.1:4173';
const NOW = '2026-11-09T10:00:00.000Z';

function runOf(results: Partial<ProjectTestPointResult>[]): ProjectTestRunRecord {
  return {
    id: `run-${Math.random().toString(36).slice(2)}`,
    mode: 'import',
    actor: 'ci',
    status: 'done',
    startedAt: new Date().toISOString(),
    results: results.map((item) => ({
      pointId: `${item.groupId}:${item.caseId}`,
      groupId: 'scenarios',
      caseId: '',
      status: 'passed',
      ...item,
    })) as ProjectTestPointResult[],
    summary: { total: results.length, passed: 0, failed: 0, skipped: 0, blocked: 0 },
  };
}

describe('recorded replay', () => {
  let root: string;
  let ids: string[];
  let opened: RecordedWalkRequest[];
  const walk = {
    open: async (request: RecordedWalkRequest) => {
      opened.push(request);
      return { taskId: `task-${opened.length}` };
    },
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-replay-'));
    opened = [];
    ids = ['Вход на стенд', 'Выход со стенда'].map(
      (title, index) =>
        recordWalk(
          root,
          { path: root, groupId: 'scenarios', title, taskId: `t${index}`, ...walkRows(ORIGIN) },
          NOW,
        ).caseId,
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const replays = (cli: RunCli) =>
    new RecordedReplays({ walk, appData: join(root, 'app-data'), runCli: cli });

  it('a green replay never opens a walk task', async () => {
    let seen: string[] = [];
    const engine = replays(async (args) => {
      seen = args;
      writeRun(root, runOf(ids.map((caseId) => ({ caseId, status: 'passed' }))));
      return { code: 0, output: '' };
    });
    engine.start(root);
    const state = await engine.settled(root)!;
    expect(state.status).toBe('passed');
    expect(opened).toHaveLength(0);
    expect(seen).toEqual(
      expect.arrayContaining(['run', '--case', ids.map((id) => `scenarios:${id}`).join(',')]),
    );
    expect(seen.slice(seen.indexOf('--max-failures'), seen.indexOf('--max-failures') + 2)).toEqual([
      '--max-failures',
      '1',
    ]);
  });

  it('opens exactly one walk task, on the first mismatch in run order, naming its step', async () => {
    const engine = replays(async () => {
      // Строки отчёта в обратном порядке и оба красные: решает порядок прогона, задача одна.
      writeRun(
        root,
        runOf([
          { caseId: ids[1]!, status: 'failed', note: 'Код выхода 1. ✗ шаг 2: ввести «x»\n  boom' },
          {
            caseId: ids[0]!,
            status: 'failed',
            note: 'Код выхода 1. ✗ шаг 5: в элемент data-testid «greeting» текст «Привет, demo»\n  не дождался',
          },
        ]),
      );
      return { code: 1, output: '' };
    });
    engine.start(root);
    const state = await engine.settled(root)!;
    expect(opened).toHaveLength(1);
    expect(state.status).toBe('mismatch');
    expect(state.mismatch).toMatchObject({
      caseId: ids[0],
      step: { n: 5, title: 'в элемент data-testid «greeting» текст «Привет, demo»' },
      taskId: 'task-1',
    });
    expect(opened[0]!.text).toContain('at step 5');
    expect(opened[0]!.title).toBe('Расхождение: Вход на стенд, шаг 5');
    expect(engine.verdict(root, 'stale').mismatch?.verdict).toBe('stale');
  });

  it('a refused walk stays on the mismatch card and a second start while running is refused', async () => {
    let release: () => void = () => undefined;
    const engine = new RecordedReplays({
      walk: {
        open: async () => {
          throw new Error('core-down: no listener');
        },
      },
      appData: join(root, 'app-data'),
      runCli: () =>
        new Promise((done) => {
          release = () => {
            writeRun(
              root,
              runOf([{ caseId: ids[0]!, status: 'failed', note: '✗ шаг 1: открыть' }]),
            );
            done({ code: 1, output: '' });
          };
        }),
    });
    engine.start(root);
    expect(() => engine.start(root)).toThrow(RecordedReplayBusyError);
    release();
    const state = await engine.settled(root)!;
    expect(state.mismatch?.walkError).toBe('core-down: no listener');
    expect(state.mismatch?.taskId).toBeUndefined();
  });

  it('no run record means a failed replay with the CLI tail, not a mismatch', async () => {
    const engine = replays(async () => ({ code: 1, output: 'Окружения «qa» нет' }));
    engine.start(root);
    const state = await engine.settled(root)!;
    expect(state).toMatchObject({ status: 'failed', error: 'Окружения «qa» нет' });
    expect(opened).toHaveLength(0);
  });
});

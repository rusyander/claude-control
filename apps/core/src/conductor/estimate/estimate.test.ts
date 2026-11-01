import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LearnedTable, TaskSample } from '../../economy/learned/index.ts';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { deps } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { estimateBody, gitRepo, testEnv, type TestEnv } from '../split/__fixtures__/split-stand.ts';
import { createTaskRegistry, type TaskRegistry } from '../tasks.ts';
import {
  ANSWER_PRESET_PROBLEM,
  ESTIMATE_HISTORY_SIGNAL,
  estimateTask,
  replayEstimate,
} from './estimate.ts';

/**
 * Числа оценки из истории (03:157, этап 5 W): настоящая оценка = создание задачи; выученное —
 * таблица E (`estimateFromHistory`). Числа пишутся строкой журнала на создании, повтор того же
 * `cmdId` отвечает ими же, даже когда история с тех пор выросла.
 */

let root: string;
let registry: TaskRegistry;
let env: TestEnv;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-estimate-'));
  const layout = layoutOf(join(root, 'home'));
  registry = createTaskRegistry(layout.tasks, deps());
  env = testEnv(layout.scenarios);
});
afterAll(() => {
  registry.closeAll();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const sample = (tokens: number, minutes: number, outcome: TaskSample['outcome'] = 'done') =>
  ({
    taskId: `t-${tokens}`,
    projects: ['elsewhere-00000000'],
    scenarioId: 'review-only',
    tokens,
    activeMs: minutes * 60_000,
    outcome,
  }) satisfies TaskSample;

const table = (tasks: TaskSample[]): LearnedTable => ({ byKey: {}, byKind: {}, tasks, skipped: 0 });

describe('estimate numbers from history (03:157)', () => {
  it('no finished task of the scenario → no-history with nulls, never invented numbers', async () => {
    const repo = gitRepo(root, 'none');
    const out = await estimateTask(
      estimateBody([repo], { scenario: { preset: 'review-only' } }),
      registry,
      env,
    );
    if (out.status === 422) throw new Error(out.problems.join('; '));
    expect(out.reply.estimate).toEqual({
      minutes: null,
      tokens: null,
      spread: null,
      basis: 'no-history',
    });
  });

  it('median and [p10, p90] of past tasks of the scenario; cancelled ones do not count; the replay answers the same numbers after history grew', async () => {
    let tasks = [
      sample(1000, 10),
      sample(2000, 20),
      sample(3000, 30),
      sample(90_000, 900, 'cancelled'),
    ];
    const withHistory: TestEnv = { ...env, history: async () => table(tasks) };
    const repo = gitRepo(root, 'hist');
    const body = estimateBody([repo], { scenario: { preset: 'review-only' } });
    const out = await estimateTask(body, registry, withHistory);
    if (out.status === 422) throw new Error(out.problems.join('; '));
    expect(out.reply.estimate.basis).toBe('history');
    expect(out.reply.estimate.tokens).toBe(2000);
    expect(out.reply.estimate.minutes).toBe(20);
    const [lo, hi] = out.reply.estimate.spread as [number, number];
    expect(lo).toBeGreaterThanOrEqual(1000);
    expect(lo).toBeLessThan(2000);
    expect(hi).toBeGreaterThan(2000);
    expect(hi).toBeLessThanOrEqual(3000);
    const signal = readJournalLines(join(registry.tasksDir, out.reply.taskId), out.reply.taskId)
      .lines.filter((l) => l.kind === 'signal')
      .map((l) => (l as JournalLine<'signal'>).data)
      .find((d) => d.signal === ESTIMATE_HISTORY_SIGNAL);
    expect(JSON.parse(signal!.detail)).toEqual(out.reply.estimate);
    tasks = [...tasks, sample(50_000, 500), sample(60_000, 600)];
    expect(replayEstimate(registry, body.cmdId)?.estimate).toEqual(out.reply.estimate);
  });
});

describe('estimate refuses the answer-reviewers preset (05:77)', () => {
  it.each([
    ['preset', { preset: 'answer-reviewers' as const }],
    ['ref', { id: 'answer-reviewers', version: 1 }],
  ])(
    'a human estimate with answer-reviewers (%s form) is 422 with the named reason and no task',
    async (form, scenario) => {
      const repo = gitRepo(root, `answer-${form}`);
      const before = registry.list().length;
      const out = await estimateTask(estimateBody([repo], { scenario }), registry, env);
      expect(out).toEqual({ status: 422, problems: [ANSWER_PRESET_PROBLEM] });
      expect(ANSWER_PRESET_PROBLEM).toMatch(/opened only by the forge poller/);
      expect(registry.list()).toHaveLength(before);
    },
  );

  it('a feature estimate on the same repo still creates its task (the refusal is by scenario only)', async () => {
    const repo = gitRepo(root, 'answer-control');
    const out = await estimateTask(estimateBody([repo]), registry, env);
    expect(out.status).toBe(202);
  });
});

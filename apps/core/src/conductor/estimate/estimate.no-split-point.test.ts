import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deps } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { estimateBody, gitRepo, testEnv, type TestEnv } from '../split/__fixtures__/split-stand.ts';
import { createTaskRegistry, type TaskRegistry } from '../tasks.ts';
import { estimateTask } from './estimate.ts';

/**
 * Сценарий без точки деления (проход по стенду, `browser-walk@1`: один шаг `walk`, ни плана, ни
 * разбора): оценке негде кончиться, и `estimating` ждало бы вечно («the scenario has no split
 * point») — проход панели висел без единого шага. Ядро делит соло сразу после единицы 0 и
 * отдаёт решение политике запуска: `auto` запускает, `confirm` спрашивает.
 */

let root: string;
let tasksDir: string;
let registry: TaskRegistry;
let env: TestEnv;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-no-split-point-'));
  const layout = layoutOf(join(root, 'home'));
  tasksDir = layout.tasks;
  registry = createTaskRegistry(layout.tasks, deps());
  env = testEnv(layout.scenarios);
});
afterAll(() => {
  registry.closeAll();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const journal = (taskId: string): JournalLine[] =>
  readJournalLines(join(tasksDir, taskId), taskId).lines;

const transitions = (lines: readonly JournalLine[]): string[] =>
  lines.flatMap((l) =>
    l.kind === 'task.transition' ? [(l as JournalLine<'task.transition'>).data.event] : [],
  );

describe('browser-walk@1 estimate: a scenario without a split point splits solo at once', () => {
  it('auto launch: one solo unit proposed by the core, accepted, the task leaves estimating and launches', async () => {
    const repo = gitRepo(root, 'walk-auto');
    const out = await estimateTask(
      estimateBody([repo], { scenario: { preset: 'browser-walk' }, launchPolicy: 'auto' }),
      registry,
      env,
    );
    if (out.status === 422) throw new Error(out.problems.join('; '));
    const lines = journal(out.reply.taskId);
    const proposed = lines.filter((l) => l.kind === 'split.proposed');
    expect(proposed).toHaveLength(1);
    const data = (proposed[0] as JournalLine<'split.proposed'>).data;
    expect(data.by).toBe('core');
    expect(data.units.map((u) => u.name)).toHaveLength(1);
    expect(transitions(lines)).toEqual(['estimate', 'estimated', 'launch']);
    expect(registry.live(out.reply.taskId)?.state.task).toBe('running');
    expect(env.raised).toHaveLength(0);
  });

  it('confirm launch: the same solo split, then the launch question — never a silent estimating', async () => {
    const repo = gitRepo(root, 'walk-confirm');
    const before = env.raised.length;
    const out = await estimateTask(
      estimateBody([repo], { scenario: { preset: 'browser-walk' }, launchPolicy: 'confirm' }),
      registry,
      env,
    );
    if (out.status === 422) throw new Error(out.problems.join('; '));
    const lines = journal(out.reply.taskId);
    expect(lines.filter((l) => l.kind === 'split.proposed')).toHaveLength(1);
    expect(transitions(lines)).toEqual(['estimate', 'estimated']);
    expect(registry.live(out.reply.taskId)?.state.task).toBe('awaiting-launch');
    const asked = env.raised.slice(before);
    expect(asked.map((r) => [r.source, r.point, r.question])).toEqual([
      ['launch', 10, 'Запустить задачу? Деление: одна единица (без деления).'],
    ]);
  });

  it('a scenario with a split point (feature) is untouched: it stays estimating until its plan step', async () => {
    const repo = gitRepo(root, 'feature-still-estimates');
    const out = await estimateTask(estimateBody([repo]), registry, env);
    if (out.status === 422) throw new Error(out.problems.join('; '));
    const lines = journal(out.reply.taskId);
    expect(lines.filter((l) => l.kind === 'split.proposed')).toHaveLength(0);
    expect(registry.live(out.reply.taskId)?.state.task).toBe('estimating');
  });
});

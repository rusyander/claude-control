import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Placement } from '@agentdeck/contracts/core/estimate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estimateTask } from '../../conductor/estimate/estimate.ts';
import { presetStep } from '../../conductor/scenario/presets.ts';
import type { StepCtx } from '../../conductor/run/run.types.ts';
import {
  estimateBody,
  gitRepo,
  testEnv,
  type TestEnv,
} from '../../conductor/split/__fixtures__/split-stand.ts';
import { createTaskRegistry, type TaskRegistry } from '../../conductor/tasks.ts';
import { deps as journalDeps, SOLO_UNIT } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { layoutOf } from '../../platform/core-home.ts';
import type { CopyWiring } from '../copy-wiring.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';
import { stepStart } from './session-start.ts';
import { createWiringHooks, IN_PLACE_SIGNAL } from './wiring.ts';

/**
 * Чат панели на месте (этап 10, Q1) через настоящую оценку и настоящие крючки F/B: начало чата —
 * грант человека на корень, поэтому копии нет (крючок копии не зовётся вовсе), сессия идёт в
 * самом корне, итог над копией не собирается. Тот же чат без гранта — обычная задача в копии:
 * без разложенной копии сессия не стартует, корень человека не трогается.
 */

let root: string;
let registry: TaskRegistry;
let env: TestEnv;
let wiringDeps: ConductorWiringDeps;
const copyCalls: string[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-in-place-'));
  const layout = layoutOf(join(root, 'home'));
  registry = createTaskRegistry(layout.tasks, journalDeps());
  env = testEnv(layout.scenarios);
  wiringDeps = {
    registry,
    layout,
    verifier: {} as ConductorWiringDeps['verifier'],
    road: {} as ConductorWiringDeps['road'],
    note: () => undefined,
  };
});
afterAll(() => {
  registry.closeAll();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** Крючок копии, который только считает вызовы: в корне чата на месте его звать нельзя. */
const spyCopy = new Proxy({} as CopyWiring, {
  get: (_, name: string) => () => {
    copyCalls.push(name);
    throw new Error(`copy.${name} called for an in-place chat`);
  },
});

const hooks = () =>
  createWiringHooks(wiringDeps, {
    copy: spyCopy,
    diskFree: async () => ({ value: { freeBytes: 500e9, totalBytes: 1e12 } }),
  });

async function chatTask(repo: string, placement?: Placement): Promise<LiveTask> {
  const out = await estimateTask(
    estimateBody([repo], {
      scenario: { preset: 'chat' },
      launchPolicy: 'auto',
      ...(placement ? { placement } : {}),
    }),
    registry,
    env,
  );
  if (out.status === 422) throw new Error(out.problems.join('; '));
  return registry.live(out.reply.taskId)!;
}

function addUnit(task: LiveTask): string {
  const unitId = newId();
  const repoKey = task.state.created!.repos[0]!.repoKey;
  task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: {
      unitId,
      repoKey,
      branch: `agentdeck/${unitId.slice(-8)}`,
      ownedPaths: [],
      ...SOLO_UNIT,
    },
  });
  return unitId;
}

const CHAT = presetStep('chat', 'chat', 'Чат', []);

function chatStep(task: LiveTask, unitId: string): StepCtx {
  return {
    taskId: task.taskId,
    unitId,
    repoKey: task.state.created!.repos[0]!.repoKey,
    copyDir: null,
    stepId: newId(),
    def: CHAT,
    round: 0,
    sessionId: null,
    routing: {
      tier: {
        ok: true,
        adapter: 'claude',
        route: { kind: 'cli-login', id: 'cli-login:claude' },
        model: null,
        alternatives: [],
        reasons: [],
      },
    } as never,
  };
}

describe('panel chat in place: the chat start is the grant for the root (Q1)', () => {
  it('unit start lays no copy and names the root once; the final gate builds nothing over a copy', async () => {
    const repo = gitRepo(root, 'chat-root');
    const task = await chatTask(repo, {
      kind: 'in-place',
      grant: { project: repo, ops: ['edit'] },
    });
    const unitId = addUnit(task);
    const ctx = { taskId: task.taskId, unitId, repoKey: 'r', copyDir: null };
    const h = hooks();
    expect(await h.onUnitStart!(ctx)).toEqual({ verdict: { ok: true }, sections: [] });
    expect(await h.onUnitStart!(ctx)).toEqual({ verdict: { ok: true }, sections: [] });
    expect(copyCalls).toEqual([]);
    const signals = readJournalLines(task.dir, task.taskId).lines.filter(
      (l) => l.kind === 'signal' && (l.data as { signal?: string }).signal === IN_PLACE_SIGNAL,
    );
    expect(signals).toHaveLength(1);
    expect((signals[0]!.data as { subject: string }).subject).toBe(realpathSync.native(repo));
    expect(await h.onFinalGate!(ctx)).toEqual({ verdict: { ok: true }, compositionId: null });
  });

  it('the chat session starts in the project root itself, with a chat brief and no step_done', async () => {
    const repo = gitRepo(root, 'chat-cwd');
    const task = await chatTask(repo, {
      kind: 'in-place',
      grant: { project: repo, ops: ['edit'] },
    });
    const unitId = addUnit(task);
    const got = stepStart({ task, pin: {} }, chatStep(task, unitId), newId());
    if (!got.ok) throw new Error(got.reason);
    expect(got.start.cwd).toBe(realpathSync.native(repo));
    expect(got.start.sourceRepo).toBe(realpathSync.native(repo));
    expect(got.start.brief).toContain('no step_done');
    // Строка копии в журнале чата на месте (чужая рука, старый журнал) места не меняет: корень.
    task.append({
      kind: 'resource.created',
      actor: 'core',
      unitId,
      data: {
        rid: newId(),
        kind: 'copy',
        owner: 'core',
        release: 'task-end',
        ref: JSON.stringify({ worktree: join(root, 'stray-copy'), repo: join(root, 'stray-src') }),
      },
    });
    const again = stepStart({ task, pin: {} }, chatStep(task, unitId), newId());
    if (!again.ok) throw new Error(again.reason);
    expect(again.start.cwd).toBe(realpathSync.native(repo));
    expect(again.start.sourceRepo).toBe(realpathSync.native(repo));
  });

  it('the same chat without the grant is a task in a copy: no laid copy, no session, the root untouched', async () => {
    const repo = gitRepo(root, 'chat-copy');
    const task = await chatTask(repo);
    const unitId = addUnit(task);
    const got = stepStart({ task, pin: {} }, chatStep(task, unitId), newId());
    expect(got).toEqual({ ok: false, reason: `unit ${unitId} has no copy` });
  });
});

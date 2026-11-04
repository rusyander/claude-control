import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EstimateResume } from '@agentdeck/contracts/core/estimate';
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
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { stepStart } from './session-start.ts';

/**
 * Чат, продолжающий разговор CLI, начатый не ядром (этап 10, F2, решение 2b), через настоящую
 * оценку: просьба `resume` ложится в `task.created`, и ПЕРВАЯ сессия шага чата несёт её дороге как
 * `adopt` — подтверждать транскрипт будет переходник (`adopt-gate`), не эта цепочка. Начатая сессия
 * шага просьбу больше не несёт: дальше разговор ядра. Просьба без чата на месте — отказ оценки.
 */

let root: string;
let registry: TaskRegistry;
let env: TestEnv;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-chat-resume-'));
  const layout = layoutOf(join(root, 'home'));
  registry = createTaskRegistry(layout.tasks, journalDeps());
  env = testEnv(layout.scenarios);
});
afterAll(() => {
  registry.closeAll();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const RESUME: EstimateResume = {
  adapter: 'claude',
  conversationId: '7e6d5c4b-3a29-4810-9f8e-7d6c5b4a3928',
};

async function estimate(repo: string, inPlace: boolean, resume?: EstimateResume) {
  return estimateTask(
    estimateBody([repo], {
      scenario: { preset: 'chat' },
      launchPolicy: 'auto',
      ...(inPlace
        ? { placement: { kind: 'in-place', grant: { project: repo, ops: ['edit'] } } }
        : {}),
      ...(resume ? { resume } : {}),
    }),
    registry,
    env,
  );
}

function addUnit(task: LiveTask): string {
  const unitId = newId();
  task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: {
      unitId,
      repoKey: task.state.created!.repos[0]!.repoKey,
      branch: `agentdeck/${unitId.slice(-8)}`,
      ownedPaths: [],
      ...SOLO_UNIT,
    },
  });
  return unitId;
}

const step = (task: LiveTask, unitId: string, stepId: string, kind: 'chat' | 'work'): StepCtx => ({
  taskId: task.taskId,
  unitId,
  repoKey: task.state.created!.repos[0]!.repoKey,
  copyDir: null,
  stepId,
  def:
    kind === 'chat'
      ? presetStep('chat', 'chat', 'Чат', [])
      : presetStep('chat', 'work', 'Работа', []),
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
});

describe('chat resuming an outside CLI conversation: estimate → first chat session (stage 10 F2)', () => {
  it('the request lands in task.created and the first chat session carries it to the road as adopt', async () => {
    const repo = gitRepo(root, 'resume-root');
    const out = await estimate(repo, true, RESUME);
    if (out.status === 422) throw new Error(out.problems.join('; '));
    const task = registry.live(out.reply.taskId)!;
    expect(task.state.created?.resume).toEqual(RESUME);
    const unitId = addUnit(task);
    const got = stepStart({ task, pin: {} }, step(task, unitId, newId(), 'chat'), newId());
    if (!got.ok) throw new Error(got.reason);
    expect(got.start.resume).toEqual({
      conversationId: RESUME.conversationId,
      adopt: { adapter: 'claude' },
    });
  });

  it('once a session of the chat step has started, the request is not carried again', async () => {
    const repo = gitRepo(root, 'resume-began');
    const out = await estimate(repo, true, RESUME);
    if (out.status === 422) throw new Error(out.problems.join('; '));
    const task = registry.live(out.reply.taskId)!;
    const unitId = addUnit(task);
    const stepId = newId();
    (task.state.sessions as Record<string, { stepId: string }>)['s-first'] = { stepId };
    const got = stepStart({ task, pin: {} }, step(task, unitId, stepId, 'chat'), newId());
    if (!got.ok) throw new Error(got.reason);
    expect(got.start.resume).toBeUndefined();
  });

  it('a task without the request starts a fresh conversation; a non-chat step never adopts', async () => {
    const plain = await estimate(gitRepo(root, 'resume-none'), true);
    if (plain.status === 422) throw new Error(plain.problems.join('; '));
    const t1 = registry.live(plain.reply.taskId)!;
    const s1 = stepStart({ task: t1, pin: {} }, step(t1, addUnit(t1), newId(), 'chat'), newId());
    if (!s1.ok) throw new Error(s1.reason);
    expect(s1.start.resume).toBeUndefined();

    const asked = await estimate(gitRepo(root, 'resume-work'), true, RESUME);
    if (asked.status === 422) throw new Error(asked.problems.join('; '));
    const t2 = registry.live(asked.reply.taskId)!;
    const s2 = stepStart({ task: t2, pin: {} }, step(t2, addUnit(t2), newId(), 'work'), newId());
    if (!s2.ok) throw new Error(s2.reason);
    expect(s2.start.resume).toBeUndefined();
  });

  it('the request outside an in-place chat is refused by the estimate, no task is made', async () => {
    const out = await estimate(gitRepo(root, 'resume-copy'), false, RESUME);
    expect(out.status).toBe(422);
    if (out.status !== 422) return;
    expect(out.problems.join(' ')).toMatch(/resume: only an in-place chat/);
  });
});

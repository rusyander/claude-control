import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdapterRegistry, CliAdapter, SessionHandle } from '../../adapters/index.ts';
import type { ConductorHooks } from '../../conductor/run/run.types.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { writeLibraryScenario } from '../../conductor/scenario/index.ts';
import { createTaskRegistry, type TaskRegistry } from '../../conductor/tasks.ts';
import {
  CREATED,
  deps,
  MINI_SCENARIO,
  tempDir,
} from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { RoadAttach, SessionEnd, SessionRoad } from '../session-road.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import type { VerifierWiring } from '../verifier-wiring/index.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';
import { startConductor } from './index.ts';
import { startLoops, type Loops } from './loops.ts';

/**
 * Обход исполнителей продукта (зона B) на настоящем реестре задач и журнале на диске: подделаны
 * только дорога сессии (запуск CLI не нужен — дорога отказывает, прикрепление записывается) и
 * переходник (исход прикрепления сессии прежнего ядра задаётся по id сессии). Настоящую загрузку
 * с подставным CLI проверяет `loops.integration.test.ts`.
 */

type Reattach = 'live' | 'lost' | 'exited' | 'unknown';

interface Stand {
  registry: TaskRegistry;
  loops: Loops;
  notes: { event: string; data: Record<string, unknown> }[];
  calls: string[];
}

const opened: Stand[] = [];
afterEach(async () => {
  for (const s of opened.splice(0)) {
    await s.loops.stop();
    s.registry.closeAll();
  }
});

function fakeRoad(calls: string[]): SessionRoad {
  return {
    prepare: async (start) => {
      calls.push(`prepare:${start.stepId}`);
      return { ok: false, reason: 'test road launches nothing' } as never;
    },
    launch: async () => ({ ok: false, reason: 'unused' }) as never,
    started: () => undefined,
    contextFor: () => ({}) as never,
    layerInventory: () => null,
    attach: (input: RoadAttach) => {
      calls.push(`attach:${input.sessionId}:${input.resumed === true}`);
      return {
        done: new Promise<void>(() => undefined),
        detach: () => undefined,
        end: async (mode) => {
          calls.push(`end:${input.sessionId}:${mode}`);
          return { stop: { how: mode }, found: [], unread: [] } as unknown as SessionEnd;
        },
      };
    },
    searchPath: async () => '',
    releaseTask: async (task) => {
      calls.push(`release:${task.taskId}`);
      return { verified: [], leaks: [], unread: [] };
    },
  } as SessionRoad;
}

function fakeAdapters(outcomes: Map<string, Reattach>, calls: string[]): AdapterRegistry {
  const adapter = {
    id: 'claude',
    reattach: async (input: { sessionId: string }) => {
      const state = outcomes.get(input.sessionId) ?? 'lost';
      calls.push(`reattach:${input.sessionId}:${state}`);
      if (state === 'live')
        return { state, handle: { sessionId: input.sessionId } as SessionHandle, replayed: 0 };
      return { state, reason: `test ${state}` };
    },
    send: async () => ({ dup: false }),
    stop: async () => undefined,
  } as unknown as CliAdapter;
  return {
    get: (id) => (id === 'claude' ? adapter : undefined),
    ids: () => ['claude'],
    all: () => [adapter],
  };
}

async function stand(
  outcomes = new Map<string, Reattach>(),
  hooks: ConductorHooks[] = [],
): Promise<Stand> {
  return loopsOn(createTaskRegistry(tempDir('loops-u-'), deps()), outcomes, hooks);
}

/** Обход над реестром: у следующего ядра — над теми же живыми задачами, свои заметки и вызовы. */
async function loopsOn(
  registry: TaskRegistry,
  outcomes: Map<string, Reattach>,
  hooks: ConductorHooks[] = [],
): Promise<Stand> {
  const scenariosDir = tempDir('loops-sc-');
  await writeLibraryScenario(scenariosDir, MINI_SCENARIO);
  const notes: Stand['notes'] = [];
  const calls: string[] = [];
  const loops = startLoops({
    registry,
    road: fakeRoad(calls),
    adapters: fakeAdapters(outcomes, calls),
    scenariosDir,
    hooks,
    note: (event, data) => notes.push({ event, data }),
    // Обход по таймеру — редко: тест будит его сам, строкой журнала или `sweep()`.
    options: { sweepMs: 60_000, pin: () => ({}) },
  });
  const s = { registry, loops, notes, calls };
  opened.push(s);
  return s;
}

async function draft(registry: TaskRegistry): Promise<LiveTask> {
  return registry.create({
    ...CREATED,
    modelCeiling: 'sonnet',
    allowedRoutes: [
      {
        adapter: 'claude',
        route: { kind: 'cli-login', id: 'cli-login:claude' },
        modelPattern: '*',
      },
    ],
  });
}

function launch(task: LiveTask): void {
  task.append({
    kind: 'task.transition',
    actor: 'core',
    data: { taskId: task.taskId, event: 'launch', from: 'draft', to: 'running' },
  });
}

async function until(probe: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('product loops over the live task registry', () => {
  it('a draft gets no runner; the launch line wakes the sweep and the task gets exactly one', async () => {
    const s = await stand();
    const task = await draft(s.registry);
    await s.loops.sweep();
    expect(s.loops.running()).toEqual([]);
    launch(task);
    await until(() => s.loops.running().includes(task.taskId), 'runner after launch');
    await s.loops.sweep();
    expect(s.notes.filter((n) => n.event === 'loop.started')).toHaveLength(1);
  });

  it('sessions of a dead core: exited → ended, lost → lost, both before the runner; an unknown one holds the task, flagged', async () => {
    const outcomes = new Map<string, Reattach>();
    const s = await stand(outcomes);
    const task = await draft(s.registry);
    launch(task);
    await s.loops.stop();
    const exited = seedSession(task, { stepKind: 'work' });
    const lost = seedSession(task, { stepKind: 'work', unitId: exited.unitId });
    outcomes.set(exited.sessionId, 'exited');
    outcomes.set(lost.sessionId, 'lost');
    const held = await draft(s.registry);
    launch(held);
    const unknown = seedSession(held, { stepKind: 'work' });
    outcomes.set(unknown.sessionId, 'unknown');

    // Тот же реестр (те же живые задачи) — новый обход, как у следующего ядра.
    const again = await loopsOn(s.registry, outcomes);
    const loops = again.loops;
    await until(() => loops.running().includes(task.taskId), 'runner of the reattached task');
    expect(task.state.sessions[exited.sessionId]?.state).toBe('ended');
    expect(task.state.sessions[lost.sessionId]?.state).toBe('lost');
    expect(again.notes.find((n) => n.event === 'loop.started')?.data).toEqual({
      taskId: task.taskId,
      resumed: 0,
    });
    await loops.sweep();
    expect(loops.running()).not.toContain(held.taskId);
    expect(held.state.sessions[unknown.sessionId]?.state).toBe('live');
    expect(s.registry.list().find((t) => t.taskId === held.taskId)?.attention).toMatch(
      /session liveness unread/,
    );
  });

  it('a live session whose step waits in checking is attached before the run; an orphan process start is stopped', async () => {
    const outcomes = new Map<string, Reattach>();
    const s = await stand(outcomes);
    const task = await draft(s.registry);
    launch(task);
    await s.loops.stop();
    const live = seedSession(task, { stepKind: 'work' });
    outcomes.set(live.sessionId, 'live');
    task.append({
      kind: 'step.transition',
      actor: 'core',
      stepId: live.stepId,
      data: { stepId: live.stepId, event: 'check', from: 'running', to: 'checking' },
    });
    task.append({
      kind: 'resource.created',
      actor: 'core',
      unitId: live.unitId,
      data: {
        rid: newId(),
        kind: 'copy',
        owner: 'core',
        release: 'task-end',
        ref: JSON.stringify({ worktree: tempDir('loops-copy-'), repo: '/r' }),
      },
    });
    const orphan = newId();
    const actionId = newId();
    task.append({
      kind: 'action.started',
      actor: 'core',
      data: {
        actionId,
        kind: 'process-start',
        target: join(tempDir('loops-orphan-'), 'sessions', orphan),
        idempotencyHint: orphan,
      },
    });
    task.append({ kind: 'action.done', actor: 'core', data: { actionId, result: null } });

    const { loops, notes, calls } = await loopsOn(s.registry, outcomes);
    await until(() => loops.running().includes(task.taskId), 'runner');
    expect(notes.find((n) => n.event === 'loop.orphan-stopped')?.data).toMatchObject({
      sessionId: orphan,
    });
    // Прикрепление — до первого хода исполнителя: раньше любой подготовки новой сессии.
    const attached = calls.indexOf(`attach:${live.sessionId}:true`);
    const prepared = calls.findIndex((c) => c.startsWith('prepare:'));
    expect(attached).toBeGreaterThanOrEqual(0);
    if (prepared >= 0) expect(attached).toBeLessThan(prepared);
    expect(notes.find((n) => n.event === 'loop.started')?.data).toEqual({
      taskId: task.taskId,
      resumed: 1,
    });
  });

  it('an ended task loses its runner; a stopped loop keeps sessions and starts nothing new', async () => {
    const s = await stand();
    const task = await draft(s.registry);
    // Задачу, созданную после обхода, видит следующий обход (таймер) — здесь он вызван сам.
    await s.loops.sweep();
    launch(task);
    await until(() => s.loops.running().includes(task.taskId), 'runner');
    task.append({
      kind: 'task.transition',
      actor: 'core',
      data: { taskId: task.taskId, event: 'cancel', from: 'running', to: 'cancelled' },
    });
    task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'cancelled' } });
    await until(() => s.loops.running().length === 0, 'runner dropped');
    // Ресурсы и аренды конца задачи снимает дорога — после снятия сессий, один раз.
    await until(() => s.calls.includes(`release:${task.taskId}`), 'task-end release');
    await s.loops.sweep();
    expect(s.calls.filter((c) => c === `release:${task.taskId}`)).toHaveLength(1);
    await s.loops.stop();
    const late = await draft(s.registry);
    launch(late);
    await s.loops.sweep();
    expect(s.loops.running()).toEqual([]);
  });

  it('a task ended without a runner gets the end hooks once; one ended under its runner is closed by the runner, never again by the sweep', async () => {
    const ends: string[] = [];
    // Крючок конца без отчёта: «закрыт» помнит только обход — повтор был бы виден вторым вызовом.
    const s = await stand(new Map(), [{ onTaskEnd: async (taskId) => void ends.push(taskId) }]);
    const drafted = await draft(s.registry);
    // Неснятая строка ресурса: без исполнителя её снимает тот же конец дороги, один раз; задача
    // без неснятого обход не будит.
    drafted.append({
      kind: 'resource.created',
      actor: 'core',
      data: {
        rid: newId(),
        kind: 'tmpdir',
        owner: 'core',
        release: 'task-end',
        ref: tempDir('loops-tmp-'),
      },
    });
    const bare = await draft(s.registry);
    end(drafted, 'draft');
    end(bare, 'draft');
    await s.loops.sweep();
    await s.loops.sweep();
    expect(ends).toEqual([drafted.taskId, bare.taskId]);
    expect(s.calls.filter((c) => c.startsWith('release:'))).toEqual([`release:${drafted.taskId}`]);
    ends.splice(1);
    expect(s.loops.running()).toEqual([]);

    const running = await draft(s.registry);
    await s.loops.sweep();
    launch(running);
    await until(() => s.loops.running().includes(running.taskId), 'runner');
    end(running, 'running');
    await until(() => s.loops.running().length === 0, 'runner dropped');
    await s.loops.sweep();
    await s.loops.sweep();
    expect(ends).toEqual([drafted.taskId, running.taskId]);
  });

  it('a runner-less end stops the sessions the journal still holds open, then runs the end hooks', async () => {
    const ends: string[] = [];
    const s = await stand(new Map(), [{ onTaskEnd: async (taskId) => void ends.push(taskId) }]);
    const task = await draft(s.registry);
    const open = seedSession(task, { stepKind: 'work' });
    expect(task.state.sessions[open.sessionId]?.state).toBe('live');
    end(task, 'draft');
    await s.loops.sweep();
    expect(task.state.sessions[open.sessionId]?.state).toBe('ended');
    expect(s.notes.find((n) => n.event === 'loop.end-session-stopped')?.data).toMatchObject({
      taskId: task.taskId,
      sessionId: open.sessionId,
    });
    expect(ends).toEqual([task.taskId]);
  });
});

/** Отмена мимо исполнителя: переход и конец задачи, как пишет `task-machine.ts`. */
function end(task: LiveTask, from: 'draft' | 'running'): void {
  const moved = task.append({
    kind: 'task.transition',
    actor: 'core',
    data: { taskId: task.taskId, event: 'cancel', from, to: 'cancelled' },
  });
  task.append({
    kind: 'task.ended',
    actor: 'core',
    cause: moved.seq,
    data: { outcome: 'cancelled' },
  });
}

describe('startConductor runs the product loops only when asked', () => {
  async function conductor(loop: ConductorWiringDeps['loop'], withAdapters = true) {
    const registry = createTaskRegistry(tempDir('loops-c-'), deps());
    const task = await draft(registry);
    launch(task);
    const calls: string[] = [];
    const handle = startConductor({
      registry,
      layout: { root: tempDir('loops-root-'), scenarios: tempDir('loops-sc-') } as CoreHomeLayout,
      // Крючкам зон обвязка проверок нужна лишь при вызове; сборка читает только профиль.
      verifier: { profile: { profileOf: () => undefined } } as unknown as VerifierWiring,
      road: fakeRoad(calls),
      note: () => undefined,
      ...(withAdapters ? { adapters: fakeAdapters(new Map(), calls) } : {}),
      ...(loop === undefined ? {} : { loop }),
    });
    return { handle, registry, task };
  }

  it('default: start() gives the launched task a runner, a second start() adds none; loop:false or no adapters — hooks only', async () => {
    const on = await conductor({ sweepMs: 20, pin: () => ({}) });
    expect(on.handle.running()).toEqual([]);
    on.handle.start();
    on.handle.start();
    await until(() => on.handle.running().includes(on.task.taskId), 'runner after start');
    expect(on.handle.running()).toEqual([on.task.taskId]);
    await on.handle.stop();
    on.registry.closeAll();

    for (const off of [await conductor(false), await conductor({ sweepMs: 20 }, false)]) {
      off.handle.start();
      await new Promise((r) => setTimeout(r, 150));
      expect(off.handle.running()).toEqual([]);
      expect(off.handle.hooks.length).toBeGreaterThan(0);
      await off.handle.stop();
      off.registry.closeAll();
    }
  });
});

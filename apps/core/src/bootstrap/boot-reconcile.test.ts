import { afterEach, describe, expect, it } from 'vitest';
import { CREATED, deps, fakeClock, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../journal/resume.ts';
import { READ_CLASSES } from '../lib/facts/read-classes.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { seedSession } from '../conductor/model-tools/__fixtures__/seed.ts';
import type { HostLiveness } from '../conductor/process-reconcile.ts';
import { ACTION_READ_CLASS, type ActionFactReaders } from '../conductor/reconcile.ts';
import { createTaskRegistry, type TaskRegistry } from '../conductor/tasks.ts';
import { createBootReconcile } from './boot-reconcile.ts';

/**
 * Сверка после загрузки (ревью F-26, F-51, F-49): нерешённое прежним ядром проверяется снова по
 * таймеру — `retry` доходит до вопроса человеку без перезапуска, хост, умерший позже, — `lost`;
 * действие, начатое уже этим ядром, таймер не трогает; сбой одной задачи помечает её, а не роняет.
 */

const failing = new Proxy({} as ActionFactReaders, {
  get: () => () => () => {
    throw Object.assign(new Error('EPERM: read'), { code: 'EPERM' });
  },
});

function started(task: LiveTask): string {
  const actionId = newId();
  task.append({
    kind: 'action.started',
    actor: 'core',
    data: { actionId, kind: 'push', target: 'origin/feature', idempotencyHint: '' },
  });
  return actionId;
}

async function until(probe: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const stops: (() => Promise<void>)[] = [];
let registry: TaskRegistry | undefined;
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  registry?.closeAll();
  registry = undefined;
});

function stand() {
  const clock = fakeClock();
  registry = createTaskRegistry(tempDir('boot-rec-'), deps({ clock }));
  return { clock, registry, notes: [] as { event: string; data: Record<string, unknown> }[] };
}

describe('boot reconcile timer', () => {
  it('F-26 an action unknown at boot reaches the point-4 ask on the timer, without a restart; an action this core started is never touched', async () => {
    const s = stand();
    const task = await s.registry.create(CREATED);
    const before = started(task);
    const rec = createBootReconcile({
      registry: s.registry,
      readers: failing,
      isAlive: async () => 'alive',
      note: (event, data) => s.notes.push({ event, data }),
      now: () => s.clock.stamp().at,
    });
    await rec.atBoot([task.taskId]);
    expect(rec.pending()).toEqual({ [task.taskId]: { actions: 1, sessions: 0 } });
    // Этим ядром начато: эффект может идти прямо сейчас — сверять его нельзя.
    const mine = started(task);
    const readClass = READ_CLASSES[ACTION_READ_CLASS.push];
    if (!('retryUntilMs' in readClass)) throw new Error('push read class has no retry deadline');
    s.clock.advance(readClass.retryUntilMs + 1);
    stops.push(rec.start(15));
    await until(() => Object.keys(rec.pending()).length === 0);
    expect(task.state.actions[before]?.status).toBe('awaiting-human');
    expect(Object.values(task.state.asks).map((a) => a.point)).toEqual([4]);
    expect(task.state.actions[mine]?.status).toBe('started');
  });

  it('F-51 a host unreadable at boot (wait) that dies later is marked lost by the timer', async () => {
    const s = stand();
    const task = await s.registry.create(CREATED);
    const { sessionId } = seedSession(task, { stepKind: 'work', hostPid: 999_999 });
    let liveness: HostLiveness = 'unknown';
    const rec = createBootReconcile({
      registry: s.registry,
      readers: failing,
      isAlive: async () => liveness,
      note: (event, data) => s.notes.push({ event, data }),
      now: () => s.clock.stamp().at,
    });
    await rec.atBoot([task.taskId]);
    expect(task.state.sessions[sessionId]?.state).toBe('live');
    expect(rec.pending()).toEqual({ [task.taskId]: { actions: 0, sessions: 1 } });
    liveness = 'dead';
    stops.push(rec.start(15));
    await until(() => task.state.sessions[sessionId]?.state === 'lost');
    await until(() => Object.keys(rec.pending()).length === 0);
  });

  it('F-49 one task whose reconcile throws is flagged for a human; the next task is still reconciled', async () => {
    const s = stand();
    const broken = await s.registry.create(CREATED);
    seedSession(broken, { stepKind: 'work', hostPid: 999_998 });
    const healthy = await s.registry.create(CREATED);
    const { sessionId } = seedSession(healthy, { stepKind: 'work', hostPid: 999_997 });
    const rec = createBootReconcile({
      registry: s.registry,
      readers: failing,
      isAlive: async (id) => {
        if (id.pid === 999_998) throw new Error('EBUSY: process table');
        return 'dead';
      },
      note: (event, data) => s.notes.push({ event, data }),
      now: () => s.clock.stamp().at,
    });
    await expect(rec.atBoot([broken.taskId, healthy.taskId])).resolves.toBeUndefined();
    const flagged = s.registry.list().find((t) => t.taskId === broken.taskId);
    expect(flagged?.attention).toMatch(/reconcile failed: EBUSY/);
    expect(healthy.state.sessions[sessionId]?.state).toBe('lost');
    expect(s.notes.map((n) => n.event)).toContain('reconcile.failed');
    expect(rec.pending()).toEqual({ [broken.taskId]: { actions: 0, sessions: 1 } });
  });
});

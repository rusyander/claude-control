import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ActionKind } from '@agentdeck/contracts/core/journal';
import { actionReaders } from '../bootstrap/action-readers.ts';
import { openFresh, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../journal/resume.ts';
import { READ_CLASSES } from '../lib/facts/read-classes.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { ActionFailed, openActions, runAction } from './outbox.ts';
import { ACTION_READ_CLASS, reconcileTask, type ActionFactReaders } from './reconcile.ts';

function started(task: LiveTask, kind: ActionKind, target: string): string {
  const actionId = newId();
  task.append({
    kind: 'action.started',
    actor: 'core',
    data: { actionId, kind, target, idempotencyHint: '' },
  });
  return actionId;
}

/** Читатели, которые всегда отвечают `unknown` (сеть легла, форж молчит). */
const failing = new Proxy({} as ActionFactReaders, {
  get: () => () => () => {
    throw Object.assign(new Error('EPERM: read'), { code: 'EPERM' });
  },
});

describe('reconcile at boot', () => {
  it('P86 fact unknown → retry until the read-class deadline → human point 4; never a blind re-execute; asked once', async () => {
    const { task } = await openFresh();
    const actionId = started(task, 'push', 'origin/feature');
    const firstAsked = new Map<string, number>();
    let now = 1_000;
    const readClass = READ_CLASSES[ACTION_READ_CLASS.push];
    if (!('retryUntilMs' in readClass)) throw new Error('push read class has no retry deadline');
    const limit = readClass.retryUntilMs;
    const boot1 = await reconcileTask(task, failing, { now: () => now }, firstAsked);
    expect(boot1.map((d) => d.verdict)).toEqual(['retry']);
    now += limit - 1;
    const boot2 = await reconcileTask(task, failing, { now: () => now }, firstAsked);
    expect(boot2.map((d) => d.verdict)).toEqual(['retry']);
    now += 2;
    const boot3 = await reconcileTask(task, failing, { now: () => now }, firstAsked);
    expect(boot3.map((d) => d.verdict)).toEqual(['ask']);
    expect(task.state.actions[actionId]?.status).toBe('awaiting-human');
    const asks = Object.values(task.state.asks);
    expect(asks.map((a) => a.point)).toEqual([4]);
    // Следующая загрузка не спрашивает снова и ничего не повторяет.
    expect(await reconcileTask(task, failing, { now: () => now }, firstAsked)).toEqual([]);
    expect(Object.values(task.state.asks)).toHaveLength(1);
    expect(Object.values(task.state.actions).filter((a) => a.kind === 'push')).toHaveLength(1);
    task.close();
  });

  it('P86 phase-6 stub readers answer unknown, never absent; copy reader reads the disk', async () => {
    const { task } = await openFresh();
    const exists = join(tempDir(), 'копия');
    mkdirSync(exists);
    const missing = join(tempDir(), 'нет');
    const created = started(task, 'copy-create', exists);
    const lost = started(task, 'copy-create', missing);
    const removed = started(task, 'copy-remove', missing);
    started(task, 'mr-create', 'feature');
    const decisions = await reconcileTask(task, actionReaders(), { now: () => 0 }, new Map());
    const byId = Object.fromEntries(decisions.map((d) => [d.actionId, d]));
    expect(byId[created]?.verdict).toBe('happened');
    expect(byId[lost]?.verdict).toBe('not-happened');
    expect(byId[removed]?.verdict).toBe('happened');
    expect(decisions.find((d) => d.readClass === 'mr.by-source-branch')).toMatchObject({
      fact: 'unknown',
      verdict: 'retry',
    });
    expect(task.state.actions[created]?.status).toBe('done');
    expect(task.state.actions[lost]?.status).toBe('failed');
    expect(openActions(task).map((a) => a.kind)).toEqual(['mr-create']);
    task.close();
  });

  it('outbox: action.started is on disk before the effect runs; failure is journaled with its code', async () => {
    const { task } = await openFresh();
    let seenStarted = false;
    const ok = await runAction(
      task,
      { kind: 'copy-create', target: '/c', idempotencyHint: '' },
      async (id) => {
        seenStarted = task.state.actions[id]?.status === 'started';
        return 'ok';
      },
    );
    expect(seenStarted).toBe(true);
    expect(ok.ok).toBe(true);
    const bad = await runAction(
      task,
      { kind: 'copy-remove', target: '/c', idempotencyHint: '' },
      async () => {
        throw new ActionFailed('busy', 'locked');
      },
    );
    expect(bad).toMatchObject({ ok: false, code: 'busy' });
    expect(task.state.actions[bad.actionId]?.status).toBe('failed');
    task.close();
  });
});

import { describe, expect, it } from 'vitest';
import type { ActionKind } from '@agentdeck/contracts/core/journal';
import { deps, fakeClock, openFresh } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import { resume, type LiveTask } from '../journal/resume.ts';
import { READ_CLASSES } from '../lib/facts/read-classes.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import {
  ACTION_READ_CLASS,
  decideReconcile,
  reconcileTask,
  type ActionFactReaders,
  type OpenAction,
} from './reconcile.ts';

/**
 * Сверка через настоящие загрузки (P86, ревью F-26): у каждой загрузки своя память — общей Map
 * между ними нет. Срок повтора обязан пережить перезапуск, иначе вопрос человеку не задаётся
 * никогда. И факт, который не доказывает действие (MR есть — не значит «обновлён», F-104).
 */

const failing = new Proxy({} as ActionFactReaders, {
  get: () => () => () => {
    throw Object.assign(new Error('EPERM: read'), { code: 'EPERM' });
  },
});

function started(task: LiveTask, kind: ActionKind, target: string): string {
  const actionId = newId();
  task.append({
    kind: 'action.started',
    actor: 'core',
    data: { actionId, kind, target, idempotencyHint: '' },
  });
  return actionId;
}

describe('reconcile across real boots', () => {
  it('F-26 P86 the retry deadline survives a restart: each boot has a fresh memory, the third boot past the deadline asks point 4', async () => {
    const clock = fakeClock();
    const d = deps({ clock });
    const fresh = await openFresh(undefined, d);
    const actionId = started(fresh.task, 'push', 'origin/feature');
    const readClass = READ_CLASSES[ACTION_READ_CLASS.push];
    if (!('retryUntilMs' in readClass)) throw new Error('push read class has no retry deadline');
    const now = { now: () => clock.stamp().at };

    const boot1 = await reconcileTask(fresh.task, failing, now, new Map());
    expect(boot1.map((x) => x.verdict)).toEqual(['retry']);
    fresh.task.close();

    clock.advance(readClass.retryUntilMs / 2);
    const second = await resume(fresh.dir, fresh.taskId, d);
    if (!second.ok) throw new Error(second.reason);
    const boot2 = await reconcileTask(second.task, failing, now, new Map());
    expect(boot2.map((x) => x.verdict)).toEqual(['retry']);
    second.task.close();

    clock.advance(readClass.retryUntilMs);
    const third = await resume(fresh.dir, fresh.taskId, d);
    if (!third.ok) throw new Error(third.reason);
    const boot3 = await reconcileTask(third.task, failing, now, new Map());
    expect(boot3.map((x) => x.verdict)).toEqual(['ask']);
    expect(third.task.state.actions[actionId]?.status).toBe('awaiting-human');
    expect(Object.values(third.task.state.asks).map((a) => a.point)).toEqual([4]);
    // Повтор `retry` в журнал не пишется: одна строка первой сверки и одна — вопроса.
    const verdicts = readJournalLines(fresh.dir, fresh.taskId)
      .lines.filter((l) => l.kind === 'decision')
      .map((l) => (l.data as unknown as { output: { verdict: string } }).output.verdict);
    expect(verdicts).toEqual(['retry', 'ask']);
    third.task.close();
  });

  it('F-104 mr-update: an existing MR does not prove the update — ask; no MR — not happened', () => {
    const action = (kind: ActionKind): OpenAction => ({
      actionId: newId(),
      kind,
      target: 'feature',
      idempotencyHint: '',
      startedAt: 0,
      startedSeq: 1,
    });
    expect(decideReconcile(action('mr-update'), { value: '!42' }, 0, 0).verdict).toBe('ask');
    expect(decideReconcile(action('mr-update'), { absent: true }, 0, 0).verdict).toBe(
      'not-happened',
    );
    expect(decideReconcile(action('mr-create'), { value: '!42' }, 0, 0).verdict).toBe('happened');
  });
});

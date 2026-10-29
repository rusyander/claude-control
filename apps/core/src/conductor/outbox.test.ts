import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { actionReaders } from '../bootstrap/action-readers.ts';
import { openFresh, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../journal/resume.ts';
import { ActionUnjournaled, openActions, runAction } from './outbox.ts';
import { reconcileTask } from './reconcile.ts';

/**
 * Внешнее действие, чей эффект случился, а запись `action.done` не легла (сбой fsync, аренда
 * потеряна): действие не объявляется проваленным — иначе повтор сделал бы второй пуш/MR
 * (ревью F-27). Оно остаётся `started`, и решает сверка по факту.
 */

function failingOn(task: LiveTask, kind: string): LiveTask {
  return new Proxy(task, {
    get(target, key) {
      if (key === 'append') {
        return (input: Parameters<LiveTask['append']>[0]) => {
          if (input.kind === kind) throw new Error('EIO: fsync failed');
          return target.append(input);
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

describe('outbox', () => {
  it('F-27 action.done fails to journal after the effect ran: no action.failed, the action stays started, reconcile reads the fact, the effect runs once', async () => {
    const { task } = await openFresh();
    const target = join(tempDir(), 'копия');
    let effects = 0;
    const run = runAction(
      failingOn(task, 'action.done'),
      { kind: 'copy-create', target, idempotencyHint: '' },
      async () => {
        effects += 1;
        mkdirSync(target);
        return 'created';
      },
    );
    await expect(run).rejects.toBeInstanceOf(ActionUnjournaled);
    expect(effects).toBe(1);
    const open = openActions(task);
    expect(open.map((a) => a.kind)).toEqual(['copy-create']);
    const decisions = await reconcileTask(task, actionReaders(), { now: Date.now }, new Map());
    expect(decisions.map((d) => d.verdict)).toEqual(['happened']);
    expect(effects).toBe(1);
    task.close();
  });
});

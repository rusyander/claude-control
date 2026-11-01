import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeClock, openFresh, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { JournalInputError, NO_MASK } from '../../journal/journal.types.ts';
import { genesisHash } from '../../journal/line.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { openWriter } from '../../journal/writer.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { JournalRejection } from '../../observer/integrity/journal-rejected.ts';
import { createRejectedSink } from './integrity.ts';

/**
 * Сигнал `journal-rejected` (этап 8, F11): отказ писателя → решение наблюдателя + строка
 * `signal` той же парой, что у предикатов; отказ собственной строки сигнала в журнал второй раз
 * не идёт (иначе отказ рождал бы отказ без конца).
 */

const open: LiveTask[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
});

/** Отказ настоящего писателя (та же строгая схема данных, что у журнала задачи). */
function realRejection(): JournalRejection {
  const dir = tempDir();
  const taskId = newId();
  let got: JournalRejection | undefined;
  const writer = openWriter(dir, {
    taskId,
    clock: fakeClock(),
    mask: NO_MASK,
    nextSeq: 1,
    lastHash: genesisHash(taskId),
    holdsLease: () => true,
    onRejected: (r) => {
      got = r;
    },
  });
  expect(() =>
    writer.append({
      kind: 'signal',
      actor: 'core',
      data: { signal: 'x', severity: 'loud', subject: 's', detail: '' },
    } as never),
  ).toThrow(JournalInputError);
  writer.close();
  if (!got) throw new Error('the writer did not call onRejected');
  return got;
}

const tail = (task: LiveTask, kinds: string[]): JournalLine[] =>
  readJournalLines(task.dir, task.taskId).lines.filter((l) => kinds.includes(l.kind));

describe('journal-rejected sink', () => {
  it('a refused line in the real writer becomes decision + warn journal-rejected naming its kind', async () => {
    const { task } = await openFresh();
    open.push(task);
    const notes: string[] = [];
    const sink = createRejectedSink({
      taskOf: (id) => (id === task.taskId ? task : undefined),
      note: (event) => notes.push(event),
    });
    sink(task.taskId, realRejection());
    const [decision, signal] = tail(task, ['decision', 'signal']);
    expect(decision?.kind).toBe('decision');
    expect((decision?.data as { class: string }).class).toBe('observer');
    expect(signal?.data).toMatchObject({
      signal: 'journal-rejected',
      severity: 'warn',
      action: 'show',
      subject: 'signal',
    });
    expect((signal?.data as { detail: string }).detail).toContain('severity');
    expect(signal?.cause).toBe(decision?.seq);
    expect(notes).toEqual([]);
  });

  it('a refused signal row of the sink itself is noted, never journaled again', async () => {
    const { task } = await openFresh();
    open.push(task);
    const notes: string[] = [];
    let calls = 0;
    // Писатель, отвергающий строку сигнала, зовёт крючок изнутри записи — тот же круг, что даст
    // отказ собственной строки `journal-rejected` в настоящем журнале.
    const rejecting: LiveTask = Object.create(task, {
      append: {
        value: (input: { kind: string }) => {
          if (input.kind !== 'signal') return task.append(input as never);
          sink(task.taskId, { kind: 'signal', issues: ['data.severity: bad'] });
          throw new JournalInputError(['data.severity: bad']);
        },
      },
    });
    const sink = createRejectedSink({
      taskOf: () => {
        calls += 1;
        return rejecting;
      },
      note: (event) => notes.push(event),
    });
    sink(task.taskId, { kind: 'tool.event', issues: ['data.tool: required'] });
    expect(calls).toBe(1);
    expect(notes).toEqual(['observer.rejected.recursion', 'observer.write.failed']);
    expect(tail(task, ['signal'])).toEqual([]);
    // Круг снят: следующий отказ снова судится.
    sink(task.taskId, { kind: 'tool.event', issues: ['x'] });
    expect(calls).toBe(2);
  });

  it('a task the observer is not attached to is only noted', () => {
    const notes: { event: string; data: unknown }[] = [];
    const sink = createRejectedSink({
      taskOf: () => undefined,
      note: (event, data) => notes.push({ event, data }),
    });
    sink('t1', { kind: 'signal', issues: ['x'] });
    expect(notes).toEqual([
      {
        event: 'observer.rejected.unsignalled',
        data: { taskId: 't1', kind: 'signal', reason: 'task not attached' },
      },
    ]);
  });
});

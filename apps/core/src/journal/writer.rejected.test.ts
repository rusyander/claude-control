import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { maskSecretsInText } from '@agentdeck/dlp/secret-mask';
import { newId } from '../lib/ids/uuidv7.ts';
import { deps, fakeClock, openFresh, tempDir } from './__fixtures__/journal-harness.ts';
import type { LiveTask } from './resume.ts';
import { JournalInputError, NO_MASK, TASK_FILES, type AppendInput } from './journal.types.ts';
import { genesisHash } from './line.ts';
import { readJournalLines } from './read-lines.ts';
import { openWriter, type WriterOptions } from './writer.ts';

/**
 * Крючок отказа писателя (этап 8, F11, сигнал `journal-rejected`): зовётся, когда отказ уже
 * лежит в `journal.rejected.jsonl`, до броска; сбой крючка отказ не подменяет; запись в журнал
 * изнутри крючка проходит — писатель в этот миг ничего не сдвинул.
 */

function writerIn(dir: string, onRejected: WriterOptions['onRejected']) {
  const taskId = newId();
  const writer = openWriter(dir, {
    taskId,
    clock: fakeClock(),
    mask: NO_MASK,
    nextSeq: 1,
    lastHash: genesisHash(taskId),
    holdsLease: () => true,
    setTimer: () => ({ cancel: () => undefined }),
    ...(onRejected ? { onRejected } : {}),
  });
  return { writer, taskId };
}

const BAD_SIGNAL = {
  kind: 'signal',
  actor: 'core',
  data: { signal: 'x', severity: 'loud', subject: 's', detail: '' },
} as unknown as AppendInput<'signal'>;

const GOOD_SIGNAL: AppendInput<'signal'> = {
  kind: 'signal',
  actor: 'core',
  data: { signal: 'journal-rejected', severity: 'warn', subject: 'signal', detail: 'd' },
};

describe('journal writer onRejected hook', () => {
  it('a data refusal calls the hook once with kind and issues after the rejected file is written, then throws', () => {
    const dir = tempDir();
    const seen: { kind: string; issues: string[]; fileAtCall: boolean }[] = [];
    const { writer } = writerIn(dir, (r) =>
      seen.push({ ...r, fileAtCall: existsSync(join(dir, TASK_FILES.rejected)) }),
    );
    expect(() => writer.append(BAD_SIGNAL)).toThrow(JournalInputError);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe('signal');
    expect(seen[0]?.fileAtCall).toBe(true);
    expect(seen[0]?.issues.join(' ')).toContain('severity');
    expect(readFileSync(join(dir, TASK_FILES.rejected), 'utf8')).toContain('"loud"');
  });

  it('an envelope refusal names (input) when the kind is missing; an accepted line never calls the hook', () => {
    const dir = tempDir();
    const kinds: string[] = [];
    const { writer } = writerIn(dir, (r) => kinds.push(r.kind));
    writer.append(GOOD_SIGNAL);
    expect(() =>
      writer.append({ actor: 'core', data: {} } as unknown as AppendInput<'signal'>),
    ).toThrow(JournalInputError);
    expect(kinds).toEqual(['(input)']);
  });

  it('a throwing hook does not replace the refusal; a line appended from inside the hook lands in order', () => {
    const dir = tempDir();
    let inner = 0;
    const box: { writer?: ReturnType<typeof writerIn>['writer'] } = {};
    const made = writerIn(dir, () => {
      inner += 1;
      box.writer?.append(GOOD_SIGNAL);
      throw new Error('hook broke');
    });
    box.writer = made.writer;
    expect(() => made.writer.append(BAD_SIGNAL)).toThrow(JournalInputError);
    expect(inner).toBe(1);
    const lines = readJournalLines(dir, made.taskId).lines;
    expect(lines.map((l) => [l.seq, l.kind])).toEqual([[1, 'signal']]);
    // Писатель цел: следующая строка идёт следующим номером.
    expect(made.writer.append(GOOD_SIGNAL).seq).toBe(2);
  });

  it('resume passes ResumeDeps.onRejected to the live task writer with its taskId; the hook appending through the live task folds in order', async () => {
    const seen: { taskId: string; kind: string }[] = [];
    const box: { task?: LiveTask } = {};
    const { task, taskId } = await openFresh(
      tempDir(),
      deps({
        onRejected: (id, r) => {
          seen.push({ taskId: id, kind: r.kind });
          box.task?.append(GOOD_SIGNAL);
        },
      }),
    );
    box.task = task;
    const before = task.state.seq;
    expect(() => task.append(BAD_SIGNAL)).toThrow(JournalInputError);
    expect(seen).toEqual([{ taskId, kind: 'signal' }]);
    expect(task.state.seq).toBe(before + 1);
    expect(readJournalLines(task.dir, taskId).lines.at(-1)?.kind).toBe('signal');
    task.close();
  });

  it('near-miss: resume without onRejected still refuses the line and writes nothing', async () => {
    const { task, taskId } = await openFresh();
    const before = readJournalLines(task.dir, taskId).lines.length;
    expect(() => task.append(BAD_SIGNAL)).toThrow(JournalInputError);
    expect(readJournalLines(task.dir, taskId).lines).toHaveLength(before);
    task.close();
  });
});

/**
 * Лишнее поле в данных (cli-x7-001): текст отказа называет поле так, что маска секретов его не
 * трогает — у zod это `Unrecognized key: "losses"`, и маска прятала имя как значение ключа.
 */
describe('journal refusal of an unknown field survives the secret mask', () => {
  it('names the field as «unrecognized field losses»; the masked message still says losses', () => {
    const { writer } = writerIn(tempDir('writer-unknown-field-'), undefined);
    const extra = {
      ...GOOD_SIGNAL,
      data: { ...GOOD_SIGNAL.data, losses: ['hooks'] },
    } as unknown as AppendInput<'signal'>;
    let caught: unknown;
    try {
      writer.append(extra);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JournalInputError);
    const message = (caught as JournalInputError).message;
    expect((caught as JournalInputError).issues).toEqual(['(data): unrecognized field losses']);
    expect(maskSecretsInText(`session not journaled: ${message}`)).toContain('losses');
  });
});

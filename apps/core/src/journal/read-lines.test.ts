import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newId } from '../lib/ids/uuidv7.ts';
import { fakeClock, tempDir } from './__fixtures__/journal-harness.ts';
import { genesisHash } from './line.ts';
import { readJournalLines } from './read-lines.ts';
import { openWriter } from './writer.ts';
import { JournalCorruptError, NO_MASK, TASK_FILES } from './journal.types.ts';

/**
 * Чтение журнала строго по порядку (ревью m1): повтор или пропуск номера — порча, а не «ещё
 * одна строка»; иначе дубль seq после сбоя fsync тихо свернулся бы дважды.
 */
function journalOf(count: number) {
  const dir = tempDir('read-');
  const taskId = newId();
  const writer = openWriter(dir, {
    taskId,
    clock: fakeClock(),
    mask: NO_MASK,
    nextSeq: 1,
    lastHash: genesisHash(taskId),
    holdsLease: () => true,
  });
  for (let i = 0; i < count; i += 1) {
    writer.append({ kind: 'error', actor: 'core', data: { code: `c${i}`, detail: '' } });
  }
  writer.close();
  const path = join(dir, TASK_FILES.journal);
  return { dir, taskId, path, raw: readFileSync(path, 'utf8').split('\n').filter(Boolean) };
}

describe('journal reader seq order', () => {
  it('m1 a repeated seq is corruption named at its line', () => {
    const { dir, taskId, path, raw } = journalOf(2);
    expect(readJournalLines(dir, taskId).lines.map((l) => l.seq)).toEqual([1, 2]);
    writeFileSync(path, `${[...raw, raw[1]].join('\n')}\n`);
    expect(() => readJournalLines(dir, taskId)).toThrow(JournalCorruptError);
    expect(() => readJournalLines(dir, taskId)).toThrow(/line 3: seq gap: found 2/);
  });

  it('m1 a skipped seq is corruption too', () => {
    const { dir, taskId, path, raw } = journalOf(3);
    writeFileSync(path, `${[raw[0], raw[2]].join('\n')}\n`);
    expect(() => readJournalLines(dir, taskId)).toThrow(/line 2: seq gap: found 3/);
  });
});

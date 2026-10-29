import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newId } from '../lib/ids/uuidv7.ts';
import { fakeClock, tempDir } from './__fixtures__/journal-harness.ts';
import { genesisHash, sha256OfText } from './line.ts';
import { readJournalLines } from './read-lines.ts';
import { upcastToCurrent, type RawLine } from './upcast.ts';
import { openWriter } from './writer.ts';
import { JournalCorruptError, NO_MASK, TASK_FILES } from './journal.types.ts';

/**
 * Ревью core-s2 F-103: апкастер, не поднявший версию, крутил чтение вечно; артефакт с верным
 * sha, но не JSON, бросал сырой SyntaxError вместо `JournalCorruptError(seq)`.
 */
describe('core-s2 journal nits (F-103)', () => {
  it('F-103 an upcaster that does not raise v by one is refused, never looped', () => {
    const line: RawLine = { v: 1, kind: 'error', data: {} };
    expect(() => upcastToCurrent(line, 2, { 1: (l) => l })).toThrow(/v1 -> v1/);
    expect(() => upcastToCurrent(line, 3, { 1: (l) => ({ ...l, v: 3 }) })).toThrow(/v1 -> v3/);
    expect(upcastToCurrent(line, 2, { 1: (l) => ({ ...l, v: 2 }) }).v).toBe(2);
  });

  it('F-103 an artifact whose bytes match its sha but are not JSON is JournalCorruptError at its seq', () => {
    const dir = tempDir('nit-');
    const taskId = newId();
    const writer = openWriter(dir, {
      taskId,
      clock: fakeClock(),
      mask: NO_MASK,
      nextSeq: 1,
      lastHash: genesisHash(taskId),
      holdsLease: () => true,
    });
    writer.append({
      kind: 'error',
      actor: 'core',
      data: { code: 'big', detail: 'x'.repeat(70_000) },
    });
    writer.close();
    const path = join(dir, TASK_FILES.journal);
    const text = readFileSync(path, 'utf8');
    const sha = /"sha256":"([0-9a-f]{64})"/.exec(text)?.[1];
    if (!sha) throw new Error('no dataRef written');
    const junk = 'not json at all';
    const junkSha = sha256OfText(junk);
    writeFileSync(join(dir, TASK_FILES.artifacts, `${junkSha}.json`), junk);
    writeFileSync(path, text.replace(sha, junkSha));
    let caught: unknown;
    try {
      readJournalLines(dir, taskId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JournalCorruptError);
    expect((caught as JournalCorruptError).seq).toBe(1);
  });
});

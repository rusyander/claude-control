import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newId } from '../lib/ids/uuidv7.ts';
import { dlpSecretMask } from '../bootstrap/secret-mask.ts';
import { readJournalLines } from './read-lines.ts';
import { genesisHash, chainHash } from './line.ts';
import { openWriter } from './writer.ts';
import { JournalInputError, NO_MASK, TASK_FILES, type AppendInput } from './journal.types.ts';
import { fakeClock, tempDir } from './__fixtures__/journal-harness.ts';

function writerIn(dir: string, opts: Partial<Parameters<typeof openWriter>[1]> = {}) {
  const taskId = newId();
  const timers: (() => void)[] = [];
  const writer = openWriter(dir, {
    taskId,
    clock: fakeClock(),
    mask: NO_MASK,
    nextSeq: 1,
    lastHash: genesisHash(taskId),
    holdsLease: () => true,
    setTimer: (fn) => {
      timers.push(fn);
      return { cancel: () => undefined };
    },
    ...opts,
  });
  return { writer, taskId, timers };
}

const SECRET = 'sk-ant-api03-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVbNm';

describe('journal writer', () => {
  it('P09 time fields come only from append: input type has none, runtime rejects them', () => {
    const dir = tempDir();
    const { writer, taskId } = writerIn(dir);
    const bad = {
      kind: 'error',
      actor: 'core',
      data: { code: 'x', detail: 'y' },
      at: 1,
    };
    const typed: AppendInput<'error'> = {
      kind: 'error',
      actor: 'core',
      data: { code: 'x', detail: 'y' },
      // @ts-expect-error — у входа записи нет `at`: время ставит только append (P09).
      at: 1,
    };
    void typed;
    expect(() => writer.append(bad as unknown as AppendInput)).toThrow(JournalInputError);
    const line = writer.append({ kind: 'error', actor: 'core', data: { code: 'x', detail: 'y' } });
    expect(line.seq).toBe(1);
    expect(line.taskId).toBe(taskId);
    expect(typeof line.at).toBe('number');
    expect(typeof line.mono).toBe('number');
    const rejected = readFileSync(join(dir, TASK_FILES.rejected), 'utf8');
    expect(rejected).toContain('"at"');
    writer.close();
  });

  it('P45 strict data: an unknown field in data is rejected into journal.rejected.jsonl, never dropped', () => {
    const dir = tempDir();
    const { writer } = writerIn(dir);
    expect(() =>
      writer.append({
        kind: 'error',
        actor: 'core',
        data: { code: 'x', detail: 'y', extra: 1 } as never,
      }),
    ).toThrow(/extra|Unrecognized/i);
    expect(existsSync(join(dir, TASK_FILES.rejected))).toBe(true);
    const journalPath = join(dir, TASK_FILES.journal);
    expect(existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '').toBe('');
    expect(readFileSync(join(dir, TASK_FILES.rejected), 'utf8')).toContain('extra');
    writer.close();
  });

  // Политика fsync проверяется на настоящих вызовах ОС — `writer.durability.test.ts` (ревью M7:
  // собственный счётчик писателя не краснел без `log.sync()`).

  it('a line over 64 KB moves its data into an artifact by sha256 and folds back intact', () => {
    const dir = tempDir();
    const { writer, taskId } = writerIn(dir);
    const big = 'я'.repeat(40_000);
    writer.append({ kind: 'error', actor: 'core', data: { code: 'big', detail: big } });
    writer.close();
    const text = readFileSync(join(dir, TASK_FILES.journal), 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThan(64 * 1024);
    expect(text).toContain('dataRef');
    expect(readdirSync(join(dir, TASK_FILES.artifacts))).toHaveLength(1);
    const read = readJournalLines(dir, taskId);
    expect((read.lines[0]?.data as { detail: string }).detail).toBe(big);
  });

  it('chain hash h_n = H(h_{n-1}, line_n) matches between writer and reader', () => {
    const dir = tempDir();
    const { writer, taskId } = writerIn(dir);
    for (let i = 0; i < 3; i += 1) {
      writer.append({ kind: 'error', actor: 'core', data: { code: `c${i}`, detail: '' } });
    }
    const last = writer.lastHash;
    writer.close();
    const raw = readFileSync(join(dir, TASK_FILES.journal), 'utf8').trim().split('\n');
    const expected = raw.reduce((h, line) => chainHash(h, line), genesisHash(taskId));
    expect(last).toBe(expected);
    expect(readJournalLines(dir, taskId).lastHash).toBe(expected);
  });

  it('P61 a planted secret never reaches journal.jsonl nor journal.rejected.jsonl', () => {
    const dir = tempDir();
    const { writer } = writerIn(dir, { mask: dlpSecretMask });
    const line = writer.append({
      kind: 'error',
      actor: 'core',
      data: { code: 'leak', detail: `ANTHROPIC_API_KEY=${SECRET} in env` },
    });
    expect(line.masked).toBeGreaterThan(0);
    expect(() =>
      writer.append({
        kind: 'error',
        actor: 'core',
        data: { code: 'leak', detail: SECRET, extra: SECRET } as never,
      }),
    ).toThrow(JournalInputError);
    // Негодная оболочка отвергается до маски данных: маска отказа — единственная защита здесь.
    expect(() =>
      writer.append({
        kind: 'error',
        actor: 'не актёр',
        data: { code: 'leak', detail: `token ${SECRET}` },
      }),
    ).toThrow(JournalInputError);
    writer.close();
    const journal = readFileSync(join(dir, TASK_FILES.journal), 'utf8');
    const rejected = readFileSync(join(dir, TASK_FILES.rejected), 'utf8');
    expect(journal).not.toContain(SECRET);
    expect(rejected).not.toContain(SECRET);
  });

  it('P74 a writer that lost its lease refuses to append', () => {
    const dir = tempDir();
    let holds = true;
    const { writer } = writerIn(dir, { holdsLease: () => holds });
    writer.append({ kind: 'error', actor: 'core', data: { code: 'a', detail: '' } });
    holds = false;
    expect(() =>
      writer.append({ kind: 'error', actor: 'core', data: { code: 'b', detail: '' } }),
    ).toThrow(/lease lost/);
    writer.close();
  });
});

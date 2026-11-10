import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { startBoardStand, type BoardStand } from '../../bootstrap/__fixtures__/board-stand.ts';
import { BoardStoreError, boardFilePath, createBoardStore, readBoardFile } from './store.ts';

/**
 * Хранилище доски (этап 12, P181): настоящий процесс, убитый SIGKILL сразу после записи, и
 * настоящий читатель рядом с писателем в другом процессе. Ничего не подменено.
 */

const CHILD = join(import.meta.dirname, '__fixtures__', 'store-child.ts');

function child(
  args: string[],
): Promise<{ code: number | null; signal: string | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', CHILD, ...args],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    c.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    c.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    c.on('error', reject);
    c.on('close', (code, signal) => resolve({ code, signal, out, err }));
  });
}

describe('board store survives a crash (P181)', () => {
  it('a process killed right after the write leaves the entry and its replay key; the replay is not applied twice', async () => {
    const root = tempDir('board-crash-');
    const cmdId = newId();
    const run = await child(['crash', root, cmdId]);
    expect(run.out).toBe('written\n');
    // Windows отдаёт убитому процессу код 1 без сигнала; POSIX — сигнал SIGKILL.
    expect(run.signal === 'SIGKILL' || run.code === 1).toBe(true);

    const store = createBoardStore({ root });
    const file = store.read();
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0]?.source).toEqual({ kind: 'manual', title: 'written before the crash' });
    const applied = store.applied(cmdId);
    expect(applied?.created).toEqual([file.entries[0]?.entryId]);

    // Повтор того же хода после краха — «уже было»: правка не зовётся, файл не меняется.
    let called = false;
    if (!store.applied(cmdId))
      store.update(cmdId, Date.now(), () => {
        called = true;
        return { ok: true };
      });
    expect(called).toBe(false);
    expect(readBoardFile(boardFilePath(root)).entries).toHaveLength(1);
  });

  it('a reader beside a writer in another process never sees a torn file', async () => {
    const root = tempDir('board-torn-');
    const path = boardFilePath(root);
    const writes = child(['churn', root, '150']);
    let done = false;
    void writes.finally(() => (done = true));
    let reads = 0;
    const torn: string[] = [];
    while (!done) {
      try {
        readBoardFile(path);
        reads += 1;
      } catch (error) {
        torn.push((error as Error).message.slice(0, 120));
      }
      await new Promise((r) => setImmediate(r));
    }
    const run = await writes;
    expect([run.code, run.err]).toEqual([0, '']);
    expect(torn).toEqual([]);
    expect(reads).toBeGreaterThan(20);
    expect(readBoardFile(path).entries).toHaveLength(150);
  }, 60_000);
});

describe('an unreadable board store is unknown, not an empty board', () => {
  let b: BoardStand;
  afterAll(async () => {
    await b?.close();
  });

  it('a broken file throws BoardStoreError; GET /v1/board answers 500 with the reason', async () => {
    const root = tempDir('board-broken-');
    writeFileSync(boardFilePath(root), '{"v":1,"entries":[');
    expect(() => createBoardStore({ root }).read()).toThrow(BoardStoreError);

    // Файл испорчен до загрузки ядра: после неё правда — память единственного писателя.
    b = await startBoardStand({
      seed: ({ s }) => writeFileSync(boardFilePath(s.layout.root), '{"v":2}'),
    });
    const res = await b.s.get('/v1/board');
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/board store failed its schema/);
  });
});

describe('a write the schema refuses never reaches the disk (W2-D)', () => {
  it('an invalid entry throws «board write refused»; file, cache and the next read stay as before', () => {
    const root = tempDir('board-refused-');
    const store = createBoardStore({ root });
    const first = newId();
    store.update(first, 1, () => ({ ok: true }));
    const path = boardFilePath(root);
    const before = readFileSync(path, 'utf8');
    expect(() =>
      store.update(newId(), 2, (file) => {
        file.entries.push({ entryId: 'not-an-id', proof: { kind: 'nobody' } } as never);
        return { ok: true };
      }),
    ).toThrow(/^board write refused: /);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(store.read()).toEqual({ v: 1, entries: [], moves: [{ cmdId: first, at: 1 }] });
    expect(readBoardFile(path).moves.map((m) => m.cmdId)).toEqual([first]);
  });
});

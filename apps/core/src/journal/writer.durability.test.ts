import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../lib/ids/uuidv7.ts';
import { genesisHash } from './line.ts';
import { readJournalLines } from './read-lines.ts';
import { resume } from './resume.ts';
import { openWriter } from './writer.ts';
import { JournalDurabilityError, NO_MASK, TASK_FILES } from './journal.types.ts';
import { deps, fakeClock, openFresh, tempDir } from './__fixtures__/journal-harness.ts';

/**
 * Долговечность журнала на настоящих вызовах ОС (ревью M5, M7, m1). `node:fs` подменён
 * сквозной обёрткой: каждый вызов идёт в настоящую ФС, обёртка только считает fsync и по
 * требованию роняет fsync или обрывает запись — ровно на дескрипторе `journal.jsonl`.
 * Прежний тест считал собственный счётчик писателя: удалённый `log.sync()` оставался зелёным.
 */
const os = vi.hoisted(() => ({
  journalFds: new Set<number>(),
  fsyncs: 0,
  failFsync: 0,
  /** Записать столько байт строки и бросить ENOSPC (оборванная запись). */
  tearAt: undefined as number | undefined,
  /** Короткая запись без ошибки: ОС взяла только столько байт за вызов. */
  shortWrite: undefined as number | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const openSync = ((path: fs.PathLike, ...rest: unknown[]) => {
    const fd = (real.openSync as (...a: unknown[]) => number)(path, ...rest);
    if (String(path).endsWith(TASK_FILES.journal)) os.journalFds.add(fd);
    return fd;
  }) as typeof real.openSync;
  const fsyncSync = ((fd: number) => {
    if (os.journalFds.has(fd)) {
      if (os.failFsync > 0) {
        os.failFsync -= 1;
        throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
      }
      os.fsyncs += 1;
    }
    real.fsyncSync(fd);
  }) as typeof real.fsyncSync;
  const writeSync = ((fd: number, buffer: unknown, ...rest: unknown[]) => {
    const write = real.writeSync as (...a: unknown[]) => number;
    if (os.journalFds.has(fd) && Buffer.isBuffer(buffer) && rest.length === 0) {
      if (os.tearAt !== undefined) {
        write(fd, buffer, 0, os.tearAt);
        os.tearAt = undefined;
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
          code: 'ENOSPC',
        });
      }
      if (os.shortWrite !== undefined) return write(fd, buffer, 0, os.shortWrite);
    }
    return write(fd, buffer, ...rest);
  }) as typeof real.writeSync;
  return {
    ...real,
    default: { ...real, openSync, fsyncSync, writeSync },
    openSync,
    fsyncSync,
    writeSync,
  };
});

afterEach(() => {
  os.failFsync = 0;
  os.tearAt = undefined;
  os.shortWrite = undefined;
});

const error = (code: string) => ({
  kind: 'error' as const,
  actor: 'core',
  data: { code, detail: '' },
});

function seqsOnDisk(dir: string): number[] {
  return readFileSync(join(dir, TASK_FILES.journal), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((text) => (JSON.parse(text) as { seq: number }).seq);
}

describe('journal durability on real fs calls', () => {
  it('M7 a decision is fsynced on the journal fd before append returns; telemetry waits for one timer fsync', () => {
    const dir = tempDir();
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
    });
    const start = os.fsyncs;
    writer.append(error('decision'));
    expect(os.fsyncs - start).toBe(1);
    const sessionId = newId();
    for (let i = 0; i < 5; i += 1) {
      writer.append({
        kind: 'tool.event',
        actor: 'core',
        data: { sessionId, effectClass: 'read', target: `f${i}`, ms: i },
      });
    }
    expect(os.fsyncs - start).toBe(1);
    expect(timers).toHaveLength(1);
    timers[0]?.();
    expect(os.fsyncs - start).toBe(2);

    // M4: fsync телеметрии падает внутри таймера — наружу не летит, следующая запись узнаёт.
    writer.append({
      kind: 'tool.event',
      actor: 'core',
      data: { sessionId, effectClass: 'read', target: 'late', ms: 1 },
    });
    os.failFsync = 1;
    expect(() => timers[1]?.()).not.toThrow();
    expect(() => writer.append(error('after'))).toThrow(JournalDurabilityError);
    writer.close();
  });

  it('M5 fsync fails after the line is on disk → seq advances with it, the writer stops, the journal stays readable and replay = live', async () => {
    const { task, dir, taskId } = await openFresh();
    task.append(error('before'));
    os.failFsync = 1;
    let thrown: unknown;
    try {
      task.append(error('unsynced'));
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBeInstanceOf(JournalDurabilityError);
    const onDisk = (thrown as JournalDurabilityError).line;
    expect(onDisk?.seq).toBe(task.state.seq);
    // Писатель закрыт: дубля seq не будет.
    expect(() => task.append(error('next'))).toThrow(JournalDurabilityError);
    const seqs = seqsOnDisk(dir);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(seqs.at(-1)).toBe(task.state.seq);
    // Цепочка писателя шагнула вместе со строкой: снимок пишет `lastHash` рядом с живым
    // состоянием; без шага он записал бы seq упавшей строки с хешем предыдущей — снимок и
    // журнал разошлись бы.
    expect(task.lastHash).toBe(readJournalLines(dir, taskId).lastHash);
    const live = task.state;
    task.close();
    const read = readJournalLines(dir, taskId);
    expect(read.lines.at(-1)?.seq).toBeGreaterThanOrEqual(live.seq);
    const again = await resume(dir, taskId, deps());
    if (!again.ok) throw new Error(again.reason);
    expect(again.task.state.commands).toEqual(live.commands);
    expect(again.task.state.counters.errors).toBe(live.counters.errors);
    again.task.close();
  });

  it('M5 a write torn mid-line is rolled back: no fragment on disk, the same seq is reused cleanly', async () => {
    const { task, dir, taskId } = await openFresh();
    const before = readFileSync(join(dir, TASK_FILES.journal));
    const seq = task.state.seq;
    os.tearAt = 12;
    expect(() => task.append(error('torn'))).toThrow(JournalDurabilityError);
    expect(readFileSync(join(dir, TASK_FILES.journal))).toEqual(before);
    expect(task.state.seq).toBe(seq);
    const line = task.append(error('after-tear'));
    expect(line.seq).toBe(seq + 1);
    task.close();
    expect(readJournalLines(dir, taskId).lines.map((l) => l.seq)).toEqual(seqsOnDisk(dir));
  });

  it('F-103 close with a pending telemetry fsync still fsyncs the journal fd (the deferred timer is cancelled, not the sync)', () => {
    const dir = tempDir();
    const taskId = newId();
    const writer = openWriter(dir, {
      taskId,
      clock: fakeClock(),
      mask: NO_MASK,
      nextSeq: 1,
      lastHash: genesisHash(taskId),
      holdsLease: () => true,
      setTimer: () => ({ cancel: () => undefined }),
    });
    writer.append({
      kind: 'tool.event',
      actor: 'core',
      data: { sessionId: newId(), effectClass: 'read', target: 'f', ms: 1 },
    });
    const start = os.fsyncs;
    writer.close();
    expect(os.fsyncs - start).toBe(1);
  });

  it('m1 a short write is completed by the loop: the whole line lands, nothing torn', async () => {
    const { task, dir, taskId } = await openFresh();
    os.shortWrite = 7;
    const line = task.append(error('short'));
    os.shortWrite = undefined;
    task.close();
    const read = readJournalLines(dir, taskId).lines;
    expect(read.find((l) => l.seq === line.seq)?.data).toEqual({ code: 'short', detail: '' });
  });
});

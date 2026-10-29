import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueueConfig, QueueLease } from '@agentdeck/contracts/core/records';
import { afterAll, describe, expect, it } from 'vitest';
import { newId } from '../../lib/ids/uuidv7.ts';
import { createCheckQueue, flightFile } from './queue.ts';

/**
 * Отказ записи очереди (A1r3-F04, B1r3-F01): удар сердца зовут голые таймеры, поэтому писатель
 * отвечает `{unknown}`, а не бросает — брошенное в `setInterval` роняло всё ядро. Отказ настоящий:
 * имена временных файлов атомарной записи заняты (`openSync(tmp,'wx')` → EEXIST), как занимал бы
 * их антивирус или полный диск. Свой файл теста — счётчик временных имён начинается с нуля.
 */

const roots: string[] = [];
function tempQueue(): string {
  const dir = join(tmpdir(), `cqw-${newId().slice(-12)}`);
  mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const CONFIG: QueueConfig = { slots: 1, shareCap: 1, agingMs: 60_000, beatMs: 1_000 };
const T = { class: 'work' as const, project: 'p', taskId: 't', key: null };

/** Занять имена `.<file>.tmp-<pid>-<n>` — следующая атомарная запись этого файла не создастся. */
function jamTmpNames(dir: string, file: string): void {
  mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= 300; n += 1)
    writeFileSync(join(dir, `.${file}.tmp-${process.pid}-${n}`), '');
}

function queueOf(dir: string, ids: () => string = newId) {
  return createCheckQueue({
    dir,
    config: () => CONFIG,
    holder: { pid: 11, start: 's11', bootId: 'b' },
    build: 'b1',
    now: () => 1_000_000,
    newId: ids,
    isAlive: async () => 'alive',
  });
}

describe('check queue write fault answers, never throws (A1r3-F04, B1r3-F01)', () => {
  it('heartbeat, beatTicket and beatInflight answer unknown when the rewrite fails', async () => {
    const dir = tempQueue();
    const q = queueOf(dir);
    const leased = q.enqueue({ ...T, project: 'p2' });
    const got = (await q.acquire(leased.ticketId)) as { granted: QueueLease };
    expect('granted' in got).toBe(true);
    const waiting = q.enqueue(T);
    expect(await q.claimInflight('p', 'k', 'run-1')).toEqual({ claimed: true });

    jamTmpNames(join(dir, 'check', 'leases'), `${got.granted.leaseId}.json`);
    jamTmpNames(join(dir, 'check', 'tickets'), `${waiting.ticketId}.json`);
    jamTmpNames(join(dir, 'check', 'inflight'), `${flightFile('p', 'k')}.lock`);

    expect(q.heartbeat(got.granted.leaseId)).toMatchObject({
      unknown: expect.stringMatching(/EEXIST/),
    });
    expect(q.beatTicket(waiting.ticketId)).toMatchObject({
      unknown: expect.stringMatching(/EEXIST/),
    });
    expect(q.beatInflight('p', 'k', 'run-1')).toMatchObject({
      unknown: expect.stringMatching(/EEXIST/),
    });
  });

  it('a lease that cannot be written is a waiting pass, the ticket stays to be served next poll', async () => {
    const dir = tempQueue();
    let fixed = false;
    const q = queueOf(dir, () => (fixed ? 'lease-jammed' : newId()));
    const t = q.enqueue(T);
    jamTmpNames(join(dir, 'check', 'leases'), 'lease-jammed.json');
    fixed = true;
    const answer = await q.acquire(t.ticketId);
    fixed = false;
    expect(answer).toMatchObject({
      waiting: 'unwritable',
      detail: expect.stringMatching(/EEXIST/),
    });
    // Билет не потерян и не выдан наполовину: следующий проход выдаёт слот.
    const again = await q.acquire(t.ticketId);
    expect('granted' in again).toBe(true);
  });
});

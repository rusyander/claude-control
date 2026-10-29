import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueueConfig, QueueLease } from '@agentdeck/contracts/core/records';
import { afterAll, describe, expect, it } from 'vitest';
import { newId } from '../../lib/ids/uuidv7.ts';
import { parseQueueSection, queueConfigReader } from './config.ts';
import { DEFAULT_QUEUE_CONFIG, MIN_BEAT_MS } from './order.ts';
import { createCheckQueue, flightFile, type CheckQueueDeps } from './queue.ts';
import type { Liveness, QueueEvent } from './queue.types.ts';

/** Очередь на настоящем каталоге (одноразовый дом ядра): аренда, отбор у мёртвого, две сборки. */

const roots: string[] = [];
function tempQueue(): string {
  const dir = join(tmpdir(), `cq-${newId().slice(-12)}`);
  mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const CONFIG: QueueConfig = { slots: 1, shareCap: 1, agingMs: 60_000, beatMs: 1_000 };

function queueOf(
  dir: string,
  over: Partial<CheckQueueDeps> & { pid?: number; clock?: { t: number } } = {},
) {
  const clock = over.clock ?? { t: 1_000_000 };
  const events: QueueEvent[] = [];
  const liveness: Record<number, Liveness> = {};
  const q = createCheckQueue({
    dir,
    config: () => CONFIG,
    holder: { pid: over.pid ?? 11, start: `s${over.pid ?? 11}`, bootId: 'b' },
    build: 'b1',
    now: () => clock.t,
    newId,
    isAlive: async (id) => liveness[id.pid] ?? 'alive',
    onEvent: (e) => events.push(e),
    ...over,
  });
  return { q, clock, events, liveness };
}

const T = { class: 'work' as const, project: 'p', taskId: 't', key: null };

describe('check queue on disk (D§3.8, 00:59)', () => {
  it('P38 a slot is granted once; the second ticket waits; release hands the slot on', async () => {
    const dir = tempQueue();
    const { q } = queueOf(dir);
    const a = q.enqueue(T);
    const b = q.enqueue(T);
    const ga = await q.acquire(a.ticketId);
    expect('granted' in ga).toBe(true);
    expect(await q.acquire(b.ticketId)).toMatchObject({ waiting: 'slot' });
    const lease = (ga as { granted: QueueLease }).granted;
    expect(lease.ticket.ticketId).toBe(a.ticketId);
    expect(q.heartbeat(lease.leaseId)).toBe('ok');
    expect(q.release(lease.leaseId)).toBe(true);
    expect('granted' in (await q.acquire(b.ticketId))).toBe(true);
    expect(await q.acquire('no-such')).toMatchObject({ gone: expect.any(String) });
  });

  it('P38 two builds share one slot count in one queue dir (00:70-71)', async () => {
    const dir = tempQueue();
    const one = queueOf(dir, { pid: 1, build: 'build-1' });
    const two = queueOf(dir, { pid: 2, build: 'build-2', clock: one.clock });
    const a = one.q.enqueue(T);
    const b = two.q.enqueue({ ...T, project: 'other' });
    const ga = await one.q.acquire(a.ticketId);
    expect('granted' in ga).toBe(true);
    expect(await two.q.acquire(b.ticketId)).toMatchObject({ waiting: 'slot' });
    expect((ga as { granted: QueueLease }).granted.ticket.build).toBe('build-1');
  });

  it('P38 stale holder: a lease 3 beats silent with a dead holder is reaped, its heartbeat answers lost; a live silent one stays', async () => {
    const dir = tempQueue();
    const holder = queueOf(dir, { pid: 7 });
    const waiter = queueOf(dir, { pid: 8, clock: holder.clock });
    const lease = (await holder.q.acquire(holder.q.enqueue(T).ticketId)) as { granted: QueueLease };
    const t = waiter.q.enqueue(T);
    holder.clock.t += 3 * CONFIG.beatMs + 1;
    waiter.q.beatTicket(t.ticketId);
    waiter.liveness[7] = 'alive';
    expect(await waiter.q.acquire(t.ticketId)).toMatchObject({ waiting: 'slot' });
    expect(waiter.events).toContainEqual(
      expect.objectContaining({ kind: 'silent-alive', holderPid: 7 }),
    );
    waiter.liveness[7] = 'dead';
    const got = await waiter.q.acquire(t.ticketId);
    expect('granted' in got).toBe(true);
    expect(waiter.events).toContainEqual(
      expect.objectContaining({ kind: 'reaped', what: 'lease', id: lease.granted.leaseId }),
    );
    expect(holder.q.heartbeat(lease.granted.leaseId)).toBe('lost');
    expect(holder.q.release(lease.granted.leaseId)).toBe(false);
  });

  it('F25 an unreadable lease file is not «no lease»: the pass waits, nothing is granted', async () => {
    const dir = tempQueue();
    const { q } = queueOf(dir);
    const t = q.enqueue(T);
    mkdirSync(join(dir, 'check', 'leases'), { recursive: true });
    writeFileSync(join(dir, 'check', 'leases', 'broken.json'), '{not json');
    expect(await q.acquire(t.ticketId)).toMatchObject({ waiting: 'unreadable' });
    expect(q.view()).toMatchObject({ unknown: expect.stringContaining('broken.json') });
    const idle = await q.idle();
    expect('unknown' in idle).toBe(true);
  });

  it('P68 one key in flight: the second claim names the holder; release frees it; a dead silent holder is taken over', async () => {
    const dir = tempQueue();
    const a = queueOf(dir, { pid: 21, config: () => ({ ...CONFIG, beatMs: 20 }) });
    const b = queueOf(dir, { pid: 22, config: () => ({ ...CONFIG, beatMs: 20 }) });
    expect(await a.q.claimInflight('p', 'k', 'run-a')).toEqual({ claimed: true });
    const second = await b.q.claimInflight('p', 'k', 'run-b');
    expect(second).toMatchObject({ claimed: false, hold: { checkRunId: 'run-a', pid: 21 } });
    expect(b.q.inflight('p', 'k')).toMatchObject({ value: { checkRunId: 'run-a' } });
    expect(b.q.inflight('p', 'other')).toEqual({ value: null });
    expect(a.q.beatInflight('p', 'k', 'run-a')).toBe('ok');
    expect(b.q.beatInflight('p', 'k', 'run-b')).toBe('lost');
    expect(a.q.releaseInflight('p', 'k', 'run-a')).toBe(true);
    expect(await b.q.claimInflight('p', 'k', 'run-b')).toEqual({ claimed: true });
    // Держатель умер и молчит дольше трёх ударов — ждущий забирает ключ.
    b.liveness[22] = 'dead';
    a.liveness[22] = 'dead';
    // Такт 20 мс ниже пола — очередь судит молчание на полу (3 × MIN_BEAT_MS).
    await new Promise((r) => setTimeout(r, 3 * MIN_BEAT_MS + 60));
    expect(await a.q.claimInflight('p', 'k', 'run-a2')).toEqual({ claimed: true });
    expect(flightFile('p', 'k')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('withdraw drops a waiting ticket; a reaped silent ticket answers gone', async () => {
    const dir = tempQueue();
    const { q, clock, liveness } = queueOf(dir, { pid: 31 });
    const a = q.enqueue(T);
    q.withdraw(a.ticketId);
    expect(await q.acquire(a.ticketId)).toMatchObject({ gone: expect.any(String) });
    const b = q.enqueue(T);
    clock.t += 3 * CONFIG.beatMs + 1;
    liveness[31] = 'dead';
    expect(await q.acquire(b.ticketId)).toMatchObject({ gone: expect.any(String) });
    expect(q.beatTicket(b.ticketId)).toBe('lost');
  });

  it('queue config: re-read per poll, rejected fields named once, unreadable keeps the last good value', () => {
    expect(parseQueueSection('{}', DEFAULT_QUEUE_CONFIG)).toEqual({
      config: DEFAULT_QUEUE_CONFIG,
      issues: [],
    });
    const bad = parseQueueSection(
      '{"queue":{"slots":0,"shareCap":0.25,"beatMs":"x"}}',
      DEFAULT_QUEUE_CONFIG,
    );
    expect(bad.config).toMatchObject({ slots: DEFAULT_QUEUE_CONFIG.slots, shareCap: 0.25 });
    expect(bad.issues).toEqual(['queue.slots: 0 rejected', 'queue.beatMs: "x" rejected']);
    expect(parseQueueSection('nope', DEFAULT_QUEUE_CONFIG).issues[0]).toMatch(/not JSON/);
    expect(parseQueueSection('{"queue":3}', DEFAULT_QUEUE_CONFIG).issues).toEqual([
      'queue: not an object',
    ]);
    // Такт ниже пола, которым бьют держатели (B1r5-F04): живой держатель выглядел бы молчащим.
    const fast = parseQueueSection(`{"queue":{"beatMs":${MIN_BEAT_MS - 1}}}`, DEFAULT_QUEUE_CONFIG);
    expect(fast.config.beatMs).toBe(DEFAULT_QUEUE_CONFIG.beatMs);
    expect(fast.issues).toEqual([`queue.beatMs: ${MIN_BEAT_MS - 1} rejected`]);
    expect(
      parseQueueSection(`{"queue":{"beatMs":${MIN_BEAT_MS}}}`, DEFAULT_QUEUE_CONFIG).config.beatMs,
    ).toBe(MIN_BEAT_MS);
    const dir = tempQueue();
    const file = join(dir, 'config.json');
    const issues: string[] = [];
    const read = queueConfigReader(file, DEFAULT_QUEUE_CONFIG, (i) => issues.push(i));
    expect(read()).toEqual(DEFAULT_QUEUE_CONFIG);
    writeFileSync(file, JSON.stringify({ queue: { slots: 5 } }));
    expect(read().slots).toBe(5);
    // Негодное поле держит прежнее хорошее значение (A1r3-F07), а не умолчание.
    writeFileSync(file, JSON.stringify({ queue: { slots: -1 } }));
    expect(read().slots).toBe(5);
    read();
    expect(issues).toEqual(['queue.slots: -1 rejected']);
    writeFileSync(file, '{garbage');
    expect(read().slots).toBe(5);
    expect(issues.at(-1)).toMatch(/not JSON/);
    // Убранный раздел — не негодный: умолчания.
    writeFileSync(file, '{}');
    expect(read().slots).toBe(DEFAULT_QUEUE_CONFIG.slots);
    // Каталог вместо файла — чтение падает: держим прежнее значение и называем причину.
    writeFileSync(file, JSON.stringify({ queue: { slots: 7 } }));
    read();
    rmSync(file);
    mkdirSync(file);
    expect(read().slots).toBe(7);
    expect(issues.at(-1)).toMatch(/unreadable/);
  });

  it('B1r5-F08 a rejected field fixed and broken again is named again; a still-broken one stays told once', () => {
    const dir = tempQueue();
    const file = join(dir, 'config.json');
    const issues: string[] = [];
    const read = queueConfigReader(file, DEFAULT_QUEUE_CONFIG, (i) => issues.push(i));
    writeFileSync(file, JSON.stringify({ queue: { slots: -1, beatMs: 'x' } }));
    read();
    read();
    expect(issues).toEqual(['queue.slots: -1 rejected', 'queue.beatMs: "x" rejected']);
    // slots исправлен, beatMs всё ещё негоден — beatMs не повторяется, slots забыт.
    writeFileSync(file, JSON.stringify({ queue: { slots: 3, beatMs: 'x' } }));
    read();
    expect(issues).toHaveLength(2);
    writeFileSync(file, JSON.stringify({ queue: { slots: -1, beatMs: 'x' } }));
    read();
    expect(issues).toEqual([
      'queue.slots: -1 rejected',
      'queue.beatMs: "x" rejected',
      'queue.slots: -1 rejected',
    ]);
    // Чистое чтение забывает всё; та же поломка потом названа снова.
    writeFileSync(file, '{}');
    read();
    writeFileSync(file, JSON.stringify({ queue: { beatMs: 'x' } }));
    read();
    expect(issues.at(-1)).toBe('queue.beatMs: "x" rejected');
    expect(issues).toHaveLength(4);
    // Нечитаемый файл (содержимое неизвестно) не забывает жалобы на поля; вернувшийся файл с той
    // же поломкой не повторяет её, а починенная нечитаемость названа снова при следующем сбое.
    rmSync(file);
    mkdirSync(file);
    read();
    expect(issues.at(-1)).toMatch(/unreadable/);
    rmSync(file, { recursive: true });
    writeFileSync(file, JSON.stringify({ queue: { beatMs: 'x' } }));
    read();
    expect(issues).toHaveLength(5);
    rmSync(file);
    mkdirSync(file);
    read();
    expect(issues).toHaveLength(6);
    expect(issues.at(-1)).toMatch(/unreadable/);
  });
});

/** Ребёнок на TS тем же node; ответ — строки JSON stdout. */
function contender(args: string[]): Promise<{ start: number; end: number; pid: number }[]> {
  const script = join(import.meta.dirname, '__fixtures__', 'contender.ts');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', script, ...args],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`contender exit ${code}: ${err}`));
      else
        resolve(
          out
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { start: number; end: number; pid: number }),
        );
    });
  });
}

function maxOverlap(spans: { start: number; end: number }[]): number {
  const points = spans.flatMap((s) => [
    { t: s.start, d: 1 },
    { t: s.end, d: -1 },
  ]);
  // Конец раньше начала в ту же миллисекунду: отпустил — потом выдали.
  points.sort((a, b) => a.t - b.t || a.d - b.d);
  let now = 0;
  let max = 0;
  for (const p of points) max = Math.max(max, (now += p.d));
  return max;
}

describe('check queue under contention (P55 pattern, per OS)', () => {
  it('P38 P55 6 processes of 3 builds race for 1 slot → never two holders at once, everyone served', async () => {
    const dir = tempQueue();
    const runs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => contender([dir, `build-${i % 3}`, '3', '25', '1'])),
    );
    const spans = runs.flat();
    expect(spans).toHaveLength(18);
    expect(maxOverlap(spans)).toBe(1);
    expect(readdirSync(join(dir, 'check', 'leases')).filter((n) => n.endsWith('.json'))).toEqual(
      [],
    );
  }, 120_000);

  it('P68 4 processes, 4 slots, one key → the key runs single-flight across processes', async () => {
    const dir = tempQueue();
    const runs = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        contender([dir, `build-${i}`, '2', '25', '4', 'same-key']),
      ),
    );
    const spans = runs.flat();
    expect(spans).toHaveLength(8);
    expect(maxOverlap(spans)).toBe(1);
    // Без ключа те же 4 процесса при 4 слотах идут вместе — проверка умеет видеть параллель.
    const freeDir = tempQueue();
    const free = await Promise.all(
      Array.from({ length: 4 }, (_, i) => contender([freeDir, `build-${i}`, '1', '1500', '4'])),
    );
    expect(free.flat()).toHaveLength(4);
    expect(maxOverlap(free.flat())).toBeGreaterThanOrEqual(2);
  }, 120_000);
});

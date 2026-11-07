import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueueConfig } from '@agentdeck/contracts/core/records';
import { afterAll, describe, expect, it } from 'vitest';
import { seatPlanner } from '../../bootstrap/allocator-wiring/planner.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { acquireExclusive, releaseExclusive } from '../../platform/exclusive-lock.ts';
import type { Liveness } from './queue.types.ts';
import { createSessionQueue, readSeats, seatsDirOf } from './session.ts';
import type { SeatEvent, SeatFile, SeatRequest } from './session.types.ts';

/**
 * Места сеансов машины на настоящем каталоге (этап 11, P141-P142): несколько ядер (разные сборки)
 * над одним `<machine>/queue`, судья выдачи — настоящий `seatPlanner` проводки. Подменены только
 * внешние границы: часы и живость процессов.
 */

const roots: string[] = [];
function tempQueue(): string {
  const dir = join(tmpdir(), `sq-${newId().slice(-12)}`);
  mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const BEAT = 1_000;
const CONFIG: QueueConfig = {
  slots: 2,
  shareCap: 1,
  agingMs: 60_000,
  beatMs: BEAT,
  sessionSlots: 6,
};

interface World {
  dir: string;
  clock: { t: number };
  /** Живость по pid; нет записи — жив. */
  alive: Record<number, Liveness>;
  config: QueueConfig;
}

function world(config: QueueConfig = CONFIG): World {
  return { dir: tempQueue(), clock: { t: 1_000_000 }, alive: {}, config };
}

function core(w: World, pid: number, build = `build-${pid}`) {
  const events: SeatEvent[] = [];
  const q = createSessionQueue({
    dir: w.dir,
    config: () => w.config,
    core: { pid, start: `s${pid}`, bootId: `boot-${pid}` },
    build,
    now: () => w.clock.t,
    newId,
    isAlive: async (id) => w.alive[id.pid] ?? 'alive',
    plan: seatPlanner,
    onEvent: (e) => events.push(e),
  });
  return { q, events };
}

const ask = (taskId: string, stepId: string, over: Partial<SeatRequest> = {}): SeatRequest => ({
  taskId,
  stepId,
  unitId: `u-${stepId}`,
  stepKind: 'work',
  cls: 'work',
  project: 'r1',
  routeId: 'cli-login:claude',
  routeCap: null,
  limit: 4,
  interactive: false,
  started: false,
  remainingMs: null,
  learnedMs: null,
  ...over,
});

const seats = (w: World): SeatFile[] => {
  const got = readSeats(seatsDirOf(w.dir));
  if (!('value' in got)) throw new Error('seats unreadable');
  return got.value;
};
const heldCount = (w: World) => seats(w).filter((s) => s.ticket.holder !== null).length;

describe('session seats of the machine (P141-P142)', () => {
  it('two cores of two builds share one count: the fifth ask under limit 4 waits and names the holder of its route', async () => {
    const w = world();
    const a = core(w, 11, 'build-a');
    const b = core(w, 22, 'build-b');
    for (const s of ['a1', 'a2', 'a3'])
      expect('granted' in (await a.q.acquire(ask('ta', s)))).toBe(true);
    w.clock.t += 10;
    expect('granted' in (await b.q.acquire(ask('tb', 'b1')))).toBe(true);
    const fifth = await b.q.acquire(ask('tb', 'b2'));
    expect(fifth).toMatchObject({ waiting: 'slot' });
    if (!('waiting' in fifth)) return;
    // Держатель того же маршрута, самый старый: первое место ядра A.
    expect(fifth.holder?.ticket.taskId).toBe('ta');
    expect(fifth.holder?.stepId).toBe('a1');
    expect(heldCount(w)).toBe(4);
    // Решение судьи несёт строки по единицам и задачам, а не по билетам.
    const detail = fifth.detail as { order: { unitId: string; taskId: string }[] };
    expect(detail.order.map((r) => [r.taskId, r.unitId])).toEqual([['tb', 'u-b2']]);
    // Место освободилось у другого ядра — ждущий получает его.
    expect(a.q.release('ta', 'a1')).toBe(true);
    expect('granted' in (await b.q.acquire(ask('tb', 'b2')))).toBe(true);
    expect(heldCount(w)).toBe(4);
  });

  it('the same step asks again → the same ticket (one seat per step, no double count)', async () => {
    const w = world();
    const a = core(w, 11);
    const first = await a.q.acquire(ask('ta', 's1'));
    const again = await a.q.acquire(ask('ta', 's1'));
    expect('granted' in first && 'granted' in again).toBe(true);
    if (!('granted' in first) || !('granted' in again)) return;
    expect(again.granted.ticket.ticketId).toBe(first.granted.ticket.ticketId);
    expect(seats(w)).toHaveLength(1);
  });

  it('a core silent three beats and proven dead is reaped; its seat goes to the waiter', async () => {
    const w = world({ ...CONFIG, sessionSlots: 1 });
    const a = core(w, 11);
    const b = core(w, 22);
    expect('granted' in (await a.q.acquire(ask('ta', 'a1', { limit: 1 })))).toBe(true);
    expect(await b.q.acquire(ask('tb', 'b1', { limit: 1 }))).toMatchObject({ waiting: 'slot' });
    // Молчит, но жив: место держится.
    w.clock.t += 3 * BEAT + 1;
    expect(await b.q.acquire(ask('tb', 'b1', { limit: 1 }))).toMatchObject({ waiting: 'slot' });
    expect(b.events.map((e) => e.kind)).toContain('seat.silent-alive');
    w.alive[11] = 'dead';
    const got = await b.q.acquire(ask('tb', 'b1', { limit: 1 }));
    expect('granted' in got).toBe(true);
    expect(b.events.find((e) => e.kind === 'seat.reaped')).toMatchObject({ taskId: 'ta' });
  });

  it('silent-alive (F25): the core is dead but the session host lives → nobody reaps, nobody adopts a foreign step', async () => {
    const w = world({ ...CONFIG, sessionSlots: 1 });
    const a = core(w, 11);
    const b = core(w, 22);
    expect('granted' in (await a.q.acquire(ask('ta', 'a1', { limit: 1 })))).toBe(true);
    expect(a.q.bind('ta', 'a1', { pid: 99, start: 's99', sessionId: 'sess-1' })).toBe(true);
    w.alive[11] = 'dead';
    w.clock.t += 3 * BEAT + 1;
    expect(await b.q.acquire(ask('tb', 'b1', { limit: 1 }))).toMatchObject({ waiting: 'slot' });
    expect(b.events.filter((e) => e.kind === 'seat.reaped')).toEqual([]);
    expect(b.events.find((e) => e.kind === 'seat.silent-alive')).toMatchObject({
      taskId: 'ta',
      holderPid: 99,
    });
    // Чужой шаг (другая задача) никто не перенимает: место по-прежнему у ядра 11.
    expect(seats(w).find((s) => s.stepId === 'a1')?.core.pid).toBe(11);
    // Хост умер тоже — место снимается.
    w.alive[99] = 'dead';
    expect('granted' in (await b.q.acquire(ask('tb', 'b1', { limit: 1 })))).toBe(true);
  });

  it('a restarted core adopts its own step only from a proven-dead core', async () => {
    const w = world();
    const old = core(w, 11);
    const fresh = core(w, 33);
    const first = await old.q.acquire(ask('ta', 's1'));
    expect('granted' in first).toBe(true);
    expect(await fresh.q.acquire(ask('ta', 's1'))).toMatchObject({
      waiting: 'held by a live core',
    });
    w.alive[11] = 'dead';
    const adopted = await fresh.q.acquire(ask('ta', 's1'));
    expect('granted' in adopted).toBe(true);
    if (!('granted' in adopted) || !('granted' in first)) return;
    expect(adopted.granted.ticket.ticketId).toBe(first.granted.ticket.ticketId);
    expect(adopted.granted.core.pid).toBe(33);
    expect(fresh.events.find((e) => e.kind === 'seat.adopted')).toMatchObject({ fromPid: 11 });
  });

  it('beat refreshes own seats but not one whose session host is proven dead; the fingerprint is the held set', async () => {
    const w = world();
    const a = core(w, 11);
    const b = core(w, 22);
    await a.q.acquire(ask('ta', 'live'));
    await a.q.acquire(ask('ta', 'gone'));
    await b.q.acquire(ask('tb', 'other'));
    a.q.bind('ta', 'live', { pid: 70, start: 's70', sessionId: 'x' });
    a.q.bind('ta', 'gone', { pid: 71, start: 's71', sessionId: 'y' });
    w.alive[71] = 'dead';
    const before = w.clock.t;
    w.clock.t += 500;
    const got = await a.q.beat();
    const byStep = Object.fromEntries(seats(w).map((s) => [s.stepId, s]));
    expect(got.hostDead).toEqual([byStep.gone!.ticket.ticketId]);
    expect(byStep.live!.beatAt).toBe(w.clock.t);
    expect(byStep.gone!.beatAt).toBe(before);
    // Чужое место ядро не бьёт.
    expect(byStep.other!.beatAt).toBe(before);
    expect(got.fingerprint.split(',').sort()).toEqual(
      seats(w)
        .map((s) => s.ticket.ticketId)
        .sort(),
    );
    // Небитое место молчит три удара, хост мёртв — другое ядро снимает его.
    w.clock.t += 3 * BEAT + 1;
    await b.q.beat();
    await b.q.acquire(ask('tb', 'next'));
    expect(seats(w).some((s) => s.stepId === 'gone')).toBe(false);
    expect(seats(w).some((s) => s.stepId === 'live')).toBe(true);
  });

  it('the owner itself drops a seat of a dead host after three missed beats: the held set changes, so a waiter of another core is woken', async () => {
    const w = world({ ...CONFIG, sessionSlots: 1 });
    const a = core(w, 11);
    const b = core(w, 22);
    await a.q.acquire(ask('ta', 'gone', { limit: 1 }));
    a.q.bind('ta', 'gone', { pid: 71, start: 's71', sessionId: 'y' });
    expect(await b.q.acquire(ask('tb', 'b1', { limit: 1 }))).toMatchObject({ waiting: 'slot' });
    const seen = (await b.q.beat()).fingerprint;
    w.alive[71] = 'dead';
    // Хост мёртв, но три удара ещё не пропущены: место держится.
    w.clock.t += BEAT;
    await a.q.beat();
    expect(seats(w).some((s) => s.stepId === 'gone')).toBe(true);
    expect((await b.q.beat()).fingerprint).toBe(seen);
    w.clock.t += 2 * BEAT + 1;
    const own = await a.q.beat();
    expect(seats(w).some((s) => s.stepId === 'gone')).toBe(false);
    expect(a.events.find((e) => e.kind === 'seat.reaped')).toMatchObject({ taskId: 'ta' });
    expect(own.fingerprint).not.toBe(seen);
    // Ядро B видит смену набора держащих — его ждущие будятся и получают место.
    expect((await b.q.beat()).fingerprint).not.toBe(seen);
    expect('granted' in (await b.q.acquire(ask('tb', 'b1', { limit: 1 })))).toBe(true);
  });

  it('a CLI that outlives its dead host keeps the seat: neither the owner nor another core hands it on until the CLI is proven dead too', async () => {
    // Замер на Linux (этап 11): хост убит, CLI в своей группе жив ещё 1,4 с после выдачи места
    // ждущему — пять живых сеансов при четырёх местах. Место ждёт доказанной смерти и CLI.
    const w = world({ ...CONFIG, sessionSlots: 1 });
    const a = core(w, 11);
    const b = core(w, 22);
    await a.q.acquire(ask('ta', 'gone', { limit: 1 }));
    a.q.bind('ta', 'gone', {
      pid: 71,
      start: 's71',
      sessionId: 'y',
      cli: { pid: 72, start: 's72' },
    });
    expect(await b.q.acquire(ask('tb', 'b1', { limit: 1 }))).toMatchObject({ waiting: 'slot' });
    w.alive[71] = 'dead';
    w.clock.t += 3 * BEAT + 1;
    // Хост мёртв, три удара пропущены, CLI жив: владелец место не бьёт, но и не снимает.
    expect((await a.q.beat()).hostDead).toHaveLength(1);
    expect(seats(w).some((s) => s.stepId === 'gone')).toBe(true);
    // Другое ядро под замком выдачи тоже не снимает: место молчит, но его CLI жив.
    expect(await b.q.acquire(ask('tb', 'b1', { limit: 1 }))).toMatchObject({ waiting: 'slot' });
    expect(seats(w).some((s) => s.stepId === 'gone')).toBe(true);
    expect(b.events.find((e) => e.kind === 'seat.reaped')).toBeUndefined();
    expect(b.events.find((e) => e.kind === 'seat.silent-alive')).toMatchObject({ taskId: 'ta' });
    // Живость CLI не прочитана — не «мёртв»: место держится.
    w.alive[72] = 'unknown';
    await a.q.beat();
    expect(seats(w).some((s) => s.stepId === 'gone')).toBe(true);
    // CLI доказанно мёртв (наблюдатель снял дерево): владелец снимает место, ждущий его получает.
    w.alive[72] = 'dead';
    await a.q.beat();
    expect(seats(w).some((s) => s.stepId === 'gone')).toBe(false);
    expect(a.events.find((e) => e.kind === 'seat.reaped')).toMatchObject({
      taskId: 'ta',
      holderPid: 71,
    });
    expect('granted' in (await b.q.acquire(ask('tb', 'b1', { limit: 1 })))).toBe(true);
  });

  it('a CLI that outlives its dead host and dead owner core: another core reaps the seat only once the CLI is proven dead', async () => {
    const w = world({ ...CONFIG, sessionSlots: 1 });
    const a = core(w, 11);
    const b = core(w, 22);
    await a.q.acquire(ask('ta', 'gone', { limit: 1 }));
    a.q.bind('ta', 'gone', {
      pid: 71,
      start: 's71',
      sessionId: 'y',
      cli: { pid: 72, start: 's72' },
    });
    w.alive[11] = 'dead';
    w.alive[71] = 'dead';
    w.clock.t += 3 * BEAT + 1;
    expect(await b.q.acquire(ask('tb', 'b1', { limit: 1 }))).toMatchObject({ waiting: 'slot' });
    expect(seats(w).some((s) => s.stepId === 'gone')).toBe(true);
    w.alive[72] = 'dead';
    expect('granted' in (await b.q.acquire(ask('tb', 'b1', { limit: 1 })))).toBe(true);
    expect(seats(w).some((s) => s.stepId === 'gone')).toBe(false);
    expect(b.events.find((e) => e.kind === 'seat.reaped')).toMatchObject({ holderPid: 71 });
  });

  it('a seat of a dead core turns reapable → the beat of another core changes its fingerprint, so its sleeping waiter asks again', async () => {
    // Устаревшее чужое место снимает только просьба под замком; ждущий спит до смены отпечатка.
    // Без неё место мёртвого ядра держало бы машину, пока кто-то другой не попросит места.
    const w = world({ ...CONFIG, sessionSlots: 1 });
    const a = core(w, 11);
    const b = core(w, 22);
    expect('granted' in (await a.q.acquire(ask('ta', 'a1', { limit: 1 })))).toBe(true);
    expect(await b.q.acquire(ask('tb', 'b1', { limit: 1 }))).toMatchObject({ waiting: 'slot' });
    const seen = (await b.q.beat()).fingerprint;
    w.alive[11] = 'dead';
    w.clock.t += BEAT;
    // Мёртв, но молчит меньше трёх ударов: снимать нечего, будить незачем.
    expect((await b.q.beat()).fingerprint).toBe(seen);
    w.clock.t += 2 * BEAT + 1;
    expect((await b.q.beat()).fingerprint).not.toBe(seen);
    expect('granted' in (await b.q.acquire(ask('tb', 'b1', { limit: 1 })))).toBe(true);
    expect(b.events.find((e) => e.kind === 'seat.reaped')).toMatchObject({ taskId: 'ta' });
  });

  it('a dead core’s waiting ticket at the head of the queue turns reapable → the waiter behind it is woken and gets the free seat', async () => {
    const w = world({ ...CONFIG, sessionSlots: 2 });
    const a = core(w, 11);
    const b = core(w, 22);
    // Место A с живым хостом держится и после смерти ядра (F25); ждущий билет A — голова очереди.
    expect('granted' in (await a.q.acquire(ask('ta', 'a1', { limit: 2 })))).toBe(true);
    expect(a.q.bind('ta', 'a1', { pid: 70, start: 's70', sessionId: 'x' })).toBe(true);
    expect(await a.q.acquire(ask('ta', 'a2', { limit: 1 }))).toMatchObject({ waiting: 'slot' });
    w.clock.t += 10;
    expect(await b.q.acquire(ask('tb', 'b1', { limit: 2 }))).toMatchObject({ waiting: 'slot' });
    const seen = (await b.q.beat()).fingerprint;
    w.alive[11] = 'dead';
    w.clock.t += 3 * BEAT + 1;
    expect((await b.q.beat()).fingerprint).not.toBe(seen);
    expect('granted' in (await b.q.acquire(ask('tb', 'b1', { limit: 2 })))).toBe(true);
    // Место живого хоста никто не снял.
    expect(seats(w).some((s) => s.stepId === 'a1')).toBe(true);
  });

  it('a seat released while the beat probes host liveness is not written back (no resurrected holder)', async () => {
    const w = world();
    let release: () => void = () => undefined;
    const q = createSessionQueue({
      dir: w.dir,
      config: () => w.config,
      core: { pid: 11, start: 's11', bootId: 'b' },
      build: 'b',
      now: () => w.clock.t,
      newId,
      // Проба хоста отпускает место посреди удара — как конец сеанса в том же процессе.
      isAlive: async (id) => {
        if (id.pid === 70) release();
        return 'alive';
      },
      plan: seatPlanner,
    });
    await q.acquire(ask('ta', 's1'));
    q.bind('ta', 's1', { pid: 70, start: 's70', sessionId: 'x' });
    release = () => {
      q.release('ta', 's1');
    };
    await q.beat();
    expect(seats(w)).toEqual([]);
  });

  it('a dead-host seat released by its session end while the beat probes is not reported reaped a second time', async () => {
    // Живой прогон двух ядер: `seat.released` (конец сеанса) и через 340 мс `seat.reaped` того же
    // места — удар прочитал вид до пробы, `removeVerified` отсутствующий путь зовёт удалённым.
    const w = world();
    let release: () => void = () => undefined;
    const events: { kind: string }[] = [];
    const q = createSessionQueue({
      dir: w.dir,
      config: () => w.config,
      core: { pid: 11, start: 's11', bootId: 'b' },
      build: 'b',
      now: () => w.clock.t,
      newId,
      isAlive: async (id) => {
        if (id.pid !== 70) return 'alive';
        release();
        return 'dead';
      },
      plan: seatPlanner,
      onEvent: (e) => events.push(e),
    });
    await q.acquire(ask('ta', 's1'));
    q.bind('ta', 's1', { pid: 70, start: 's70', sessionId: 'x' });
    let released = false;
    release = () => {
      if (!released) released = q.release('ta', 's1');
    };
    w.clock.t += 3 * BEAT + 1;
    await q.beat();
    expect(released).toBe(true);
    expect(seats(w)).toEqual([]);
    expect(events.filter((e) => e.kind === 'seat.reaped')).toEqual([]);
  });

  it('a chat seat is always granted and never counted against the work limit', async () => {
    const w = world();
    const a = core(w, 11);
    for (const s of ['w1', 'w2'])
      expect('granted' in (await a.q.acquire(ask('ta', s, { limit: 2 })))).toBe(true);
    const chat = await a.q.acquire(
      ask('tc', 'c1', { stepKind: 'chat', interactive: true, limit: 2 }),
    );
    expect('granted' in chat).toBe(true);
    expect(await a.q.acquire(ask('ta', 'w3', { limit: 2 }))).toMatchObject({ waiting: 'slot' });
    expect(a.q.release('ta', 'w1')).toBe(true);
    // Чат держит место, но счёт — 1 работы из 2: третья работа идёт.
    expect('granted' in (await a.q.acquire(ask('ta', 'w3', { limit: 2 })))).toBe(true);
  });

  it('a chat never waits: the grant lock held by another live core does not hold a chat seat back', async () => {
    const w = world();
    const a = core(w, 11);
    // Замок выдачи держит живое ядро 22 (его просьба идёт сейчас).
    const lock = join(w.dir, 'session', '.grant.lock');
    const holder = {
      leaseId: 'l-22',
      pid: 22,
      pidStart: 's22',
      bootId: 'boot-22',
      build: 'b',
      acquiredAt: w.clock.t,
    };
    const got = await acquireExclusive(lock, holder, {
      isAlive: async () => 'alive',
      isSilent: () => false,
      now: () => w.clock.t,
    });
    expect(got.acquired).toBe(true);
    const chat = await a.q.acquire(ask('tc', 'c1', { stepKind: 'chat', interactive: true }));
    expect('granted' in chat).toBe(true);
    // Работа под тем же замком ждёт, как и прежде.
    expect(await a.q.acquire(ask('ta', 'w1'))).toMatchObject({ waiting: 'contended: held' });
    // Чат того же шага снова — то же место, без второго файла.
    await a.q.acquire(ask('tc', 'c1', { stepKind: 'chat', interactive: true }));
    expect(seats(w).filter((s) => s.stepId === 'c1')).toHaveLength(1);
    releaseExclusive(lock, 'l-22');
  });

  it('release frees only own seats: a foreign core cannot drop them', async () => {
    const w = world();
    const a = core(w, 11);
    const b = core(w, 22);
    await a.q.acquire(ask('ta', 's1'));
    expect(b.q.release('ta', 's1')).toBe(false);
    expect(seats(w)).toHaveLength(1);
    expect(a.q.release('ta', 's1')).toBe(true);
    expect(seats(w)).toHaveLength(0);
    expect(a.q.release('ta', 's1')).toBe(false);
  });

  it('route cap 1 (local:own) runs serially while another route goes ahead', async () => {
    const w = world();
    const a = core(w, 11);
    const b = core(w, 22);
    const own = { routeId: 'local:own', routeCap: 1 };
    expect('granted' in (await a.q.acquire(ask('ta', 'o1', own)))).toBe(true);
    expect(await b.q.acquire(ask('tb', 'o2', own))).toMatchObject({ waiting: 'route' });
    // Полный маршрут голову очереди не держит: другой маршрут получает место.
    expect('granted' in (await b.q.acquire(ask('tb', 'cloud')))).toBe(true);
    expect(a.q.release('ta', 'o1')).toBe(true);
    expect('granted' in (await b.q.acquire(ask('tb', 'o2', own)))).toBe(true);
  });
});

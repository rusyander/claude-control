import { describe, expect, it } from 'vitest';
import { RouteAborted } from '../../lease.ts';
import { createSlotQueue } from './slot.ts';
import { decideSlotWait, type SlotWaitInput } from './slot-wait.ts';

const base: SlotWaitInput = {
  subject: 'waiter',
  liveness: 'dead',
  elapsedMs: 0,
  reissueWindowMs: 1_000,
  retryUntilMs: 5_000,
};
const act = (input: Partial<SlotWaitInput>) => decideSlotWait({ ...base, ...input }).action;

describe('slot-wait — the fate of a slot holder or a place after a core restart (11 R:PR-04, 01 F09)', () => {
  it('server: alive holds, dead / absent frees, unknown retries until the deadline then raises a human point (never frees)', () => {
    const server = { subject: 'server' as const };
    expect(act({ ...server, liveness: 'alive' })).toBe('hold');
    expect(act({ ...server, liveness: 'dead' })).toBe('release');
    expect(act({ ...server, liveness: 'absent' })).toBe('release');
    expect(act({ ...server, liveness: 'unknown', elapsedMs: 4_999 })).toBe('retry');
    expect(act({ ...server, liveness: 'unknown', elapsedMs: 5_000 })).toBe('human-point');
    expect(act({ ...server, liveness: 'unknown', elapsedMs: 10 ** 9 })).toBe('human-point');
  });

  it('waiter: owner alive → foreign; dead or unrecorded → kept for the window, then removed; unknown → retry, then human point even past the window', () => {
    expect(act({ liveness: 'alive', elapsedMs: 4_999 })).toBe('foreign');
    expect(act({ liveness: 'dead', elapsedMs: 999 })).toBe('hold');
    expect(act({ liveness: 'dead', elapsedMs: 1_000 })).toBe('release');
    expect(act({ liveness: 'absent', elapsedMs: 999 })).toBe('hold');
    expect(act({ liveness: 'absent', elapsedMs: 1_000 })).toBe('release');
    expect(act({ liveness: 'unknown', elapsedMs: 2_000 })).toBe('retry');
    expect(act({ liveness: 'unknown', elapsedMs: 5_000 })).toBe('human-point');
    expect(decideSlotWait({ ...base, liveness: 'absent', elapsedMs: 1_000 }).reasons).toEqual([
      'waiter owner not recorded; not re-issued within 1000 ms: place removed',
    ]);
  });

  it('F-88 waiter: a live foreign core’s place is never removed at any age — past the class deadline it raises a human point, never `release`', () => {
    for (const elapsedMs of [0, 1_000, 4_999])
      expect(act({ liveness: 'alive', elapsedMs })).toBe('foreign');
    for (const elapsedMs of [5_000, 10 ** 9]) {
      const decision = decideSlotWait({ ...base, liveness: 'alive', elapsedMs });
      expect(decision.action).toBe('human-point');
      expect(decision.reasons).toEqual([
        `waiter core alive by identity; its place blocks the slot after ${elapsedMs} ms (slot-wait deadline 5000 ms)`,
        'place stays: a live core’s place is never cancelled or taken over',
      ]);
    }
  });

  it('F-88 lease: a live or unproven foreign core’s lease is never adopted at any age — past the deadline a human point; a dead owner (or a gone server of an unowned lease) → adopt, never `release`', () => {
    const lease = (input: Partial<SlotWaitInput>) =>
      decideSlotWait({ ...base, subject: 'lease', ...input });
    for (const elapsedMs of [0, 4_999]) {
      expect(lease({ liveness: 'alive', elapsedMs }).action).toBe('foreign');
      expect(lease({ liveness: 'unknown', elapsedMs }).action).toBe('retry');
    }
    for (const elapsedMs of [5_000, 10 ** 9]) {
      expect(lease({ liveness: 'alive', elapsedMs })).toEqual({
        action: 'human-point',
        reasons: [
          `lease owner core alive by identity; its lease blocks the slot after ${elapsedMs} ms (slot-wait deadline 5000 ms)`,
          'lease stays: a live core’s lease is never cancelled or taken over',
        ],
      });
      expect(lease({ liveness: 'unknown', elapsedMs }).reasons[1]).toBe(
        'lease stays with its core: never adopted, released or stopped while unproven',
      );
    }
    // Окно повторной выдачи — для мест; мёртвый владелец аренды не ждёт его.
    for (const liveness of ['dead', 'absent'] as const)
      expect(lease({ liveness, elapsedMs: 0 }).action).toBe('adopt');
  });
});

describe('slot queue — a kept place of a previous core', () => {
  it('free slot goes to the place at once; claim takes it, a later acquire waits for its release', async () => {
    const slots = createSlotQueue();
    const place = slots.reserve('gpu', 5);
    expect(place.granted).toBe(true);
    let later = false;
    const next = slots.acquire('gpu', undefined, 10).then((hold) => ((later = true), hold));
    const hold = await place.claim();
    await Promise.resolve();
    expect(later).toBe(false);
    hold.release();
    (await next).release();
    expect(later).toBe(true);
    expect(slots.held('gpu')).toBe(false);
  });

  it('a waiting place ranks by its old rank; cancel hands a granted slot on; abort while claiming leaves the queue', async () => {
    const slots = createSlotQueue();
    const first = await slots.acquire('gpu');
    const newer = slots.acquire('gpu', undefined, 20);
    const place = slots.reserve('gpu', 5);
    expect(slots.waiting('gpu')).toBe(2);
    first.release();
    expect(place.granted).toBe(true);
    place.cancel();
    place.cancel();
    (await newer).release();
    expect(slots.held('gpu')).toBe(false);

    const blocker = await slots.acquire('gpu');
    const other = slots.reserve('gpu', 1);
    const controller = new AbortController();
    const claimed = other.claim(controller.signal);
    controller.abort();
    await expect(claimed).rejects.toBeInstanceOf(RouteAborted);
    expect(slots.waiting('gpu')).toBe(0);
    await expect(other.claim()).rejects.toThrow(/already claimed or cancelled/);
    // Снятое место, до которого очередь не дошла, уходит из очереди: слот ему не достаётся.
    const dropped = slots.reserve('gpu', 2);
    expect(slots.waiting('gpu')).toBe(1);
    dropped.cancel();
    expect(slots.waiting('gpu')).toBe(0);
    blocker.release();
    expect(dropped.granted).toBe(false);
    expect(slots.held('gpu')).toBe(false);
  });
});

describe('slot queue — adopting holders that survived a core restart (F-67)', () => {
  it('F-67 adopt never waits: two restored servers on one slot both hold it; the slot frees only after both release, then the waiter gets it', async () => {
    const slots = createSlotQueue();
    const first = slots.adopt('gpu');
    const second = slots.adopt('gpu');
    expect(slots.held('gpu')).toBe(true);
    let granted = false;
    const waiter = slots.acquire('gpu', undefined, 1).then((hold) => ((granted = true), hold));
    first.release();
    first.release();
    await Promise.resolve();
    expect(granted).toBe(false);
    expect(slots.held('gpu')).toBe(true);
    second.release();
    (await waiter).release();
    expect(granted).toBe(true);
    expect(slots.held('gpu')).toBe(false);
  });

  it('F-67 adopt beside a live holder of this process holds at once; the holder releasing does not hand the slot on while the adopted server lives', async () => {
    const slots = createSlotQueue();
    const live = await slots.acquire('gpu');
    const adopted = slots.adopt('gpu');
    let granted = false;
    const waiter = slots.acquire('gpu', undefined, 1).then((hold) => ((granted = true), hold));
    live.release();
    await Promise.resolve();
    expect(granted).toBe(false);
    adopted.release();
    (await waiter).release();
    expect(granted).toBe(true);
    expect(slots.held('gpu')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { activeElapsed, createClock, JUMP_THRESHOLD_MS, TICK_MS } from './clock.ts';

/** Поддельные стенные и монотонные часы: сон на Windows (mono идёт) и на POSIX (mono стоит). */
function fakeSource() {
  let wall = 1_760_000_000_000;
  let mono = 0;
  return {
    source: { wall: () => wall, mono: () => mono },
    tick(ms = TICK_MS) {
      wall += ms;
      mono += ms;
    },
    sleepMonoRuns(ms: number) {
      wall += ms;
      mono += ms;
    },
    sleepMonoStops(ms: number) {
      wall += ms;
    },
  };
}

describe('core clock', () => {
  it('P56 sleep with a running monotonic clock (Windows) → clock.jump, work time excludes the sleep', () => {
    const f = fakeSource();
    const clock = createClock(f.source, 'boot');
    const start = clock.activeMono();
    for (let i = 0; i < 10; i += 1) {
      f.tick();
      expect(clock.tick()).toBeUndefined();
    }
    f.sleepMonoRuns(2 * 60 * 60_000);
    const jump = clock.tick();
    expect(jump?.suspendedMs).toBe(2 * 60 * 60_000 - TICK_MS);
    expect(activeElapsed(clock, start)).toBe(10 * TICK_MS + TICK_MS);
    // Срок застоя 5 минут по активному времени не истёк, хотя по стенным прошло 2 часа.
    expect(activeElapsed(clock, start) < 5 * 60_000).toBe(true);
  });

  it('P56 sleep with a stopped monotonic clock (Linux/macOS) → wall shift named, active time unchanged', () => {
    const f = fakeSource();
    const clock = createClock(f.source, 'boot');
    const start = clock.activeMono();
    f.tick();
    clock.tick();
    f.sleepMonoStops(3 * 60 * 60_000);
    f.tick();
    const jump = clock.tick();
    expect(jump).toMatchObject({ suspendedMs: 0, wallShiftMs: 3 * 60 * 60_000 });
    expect(activeElapsed(clock, start)).toBe(2 * TICK_MS);
  });

  it('P56 small scheduler jitter is not a jump; stamp is integer wall ms + mono of this boot', () => {
    const f = fakeSource();
    const clock = createClock(f.source, 'boot-1');
    f.tick(TICK_MS + JUMP_THRESHOLD_MS - 1);
    expect(clock.tick()).toBeUndefined();
    const stamp = clock.stamp();
    expect(Number.isInteger(stamp.at)).toBe(true);
    expect(clock.bootId).toBe('boot-1');
  });
});
